#!/usr/bin/env python3
"""Import real PR references and freeze an audited 24-positive/16-negative set.

Python 3.10+, standard library only. No model requests, no project execution,
no remote writes, no automatic human attestations. All outputs are outside the
reviewed repositories. Drafts are NEVER accepted as final scoring gold.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from collections import Counter
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SHA = re.compile(r"^[0-9a-f]{40}$")
REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
SEED = "mergewarden-real-python40-v1-20260921"

class AdmissionError(ValueError):
    pass

def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")

def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()

def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))

def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def write_jsonl(path: Path, values: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(v, ensure_ascii=False) + "\n" for v in values), encoding="utf-8")

def read_jsonl(path: Path) -> list[dict]:
    out = []
    with path.open(encoding="utf-8-sig") as stream:
        for line_no, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise AdmissionError(f"Invalid JSONL at {path.name}:{line_no}") from exc
            if not isinstance(row, dict):
                raise AdmissionError(f"Expected object at {path.name}:{line_no}")
            out.append(row)
    return out

def normal_id(value: str) -> str:
    return value.removeprefix("reviewbench/").lower()

def row_payload(row: dict) -> dict:
    # The released main file is a SWE-CARE instance. Accommodate explicit
    # wrappers only; do not infer repo/commit identities from unrelated text.
    if "instance_id" in row:
        return row
    for key in ("instance", "data", "task"):
        v = row.get(key)
        if isinstance(v, dict) and "instance_id" in v:
            return v
    raise AdmissionError("Unrecognized dataset row: missing explicit instance_id")

def checked_sha(value: Any, field: str) -> str:
    if not isinstance(value, str) or not SHA.fullmatch(value.lower()):
        raise AdmissionError(f"{field}: a complete 40-character commit SHA is required")
    return value.lower()

def check_source_file(path: Path, spec: dict) -> dict:
    size = path.stat().st_size
    if size != spec["size_bytes"]:
        raise AdmissionError(f"Size mismatch for {path.name}: {size}; expected {spec['size_bytes']}")
    git_hash = hashlib.sha1(f"blob {size}\0".encode())
    sha256 = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            git_hash.update(block)
            sha256.update(block)
    if git_hash.hexdigest() != spec["git_blob_sha1"]:
        raise AdmissionError(f"Git blob mismatch for {path.name}; do not continue with changed upstream data")
    return {"git_blob_sha1": git_hash.hexdigest(), "sha256": sha256.hexdigest(), "size_bytes": size}

def source_path(cache: Path, name: str, spec: dict) -> Path:
    return cache / (name + Path(spec["path"]).suffix)

def fetch_sources(cache: Path, only: list[str] | None = None) -> None:
    specs = load_json(ROOT / "manifests/sources.lock.json")["files"]
    cache.mkdir(parents=True, exist_ok=True)
    wanted = only or list(specs)
    for name in wanted:
        spec = specs[name]
        target = source_path(cache, name, spec)
        if target.exists():
            check_source_file(target, spec)
            print(f"verified cached {name}", file=sys.stderr)
            continue
        tmp = target.with_suffix(target.suffix + ".part")
        last = None
        for attempt in range(3):
            try:
                req = urllib.request.Request(spec["url"], headers={"User-Agent": "MergeWarden-RealGolden40/1.0"})
                n = 0
                with urllib.request.urlopen(req, timeout=90) as res, tmp.open("wb") as stream:
                    for chunk in iter(lambda: res.read(1024 * 1024), b""):
                        n += len(chunk)
                        if n > spec["size_bytes"]:
                            raise AdmissionError("Download larger than pinned object")
                        stream.write(chunk)
                check_source_file(tmp, spec)
                os.replace(tmp, target)
                print(f"downloaded and verified {name}", file=sys.stderr)
                break
            except (OSError, AdmissionError) as exc:
                last = exc
                tmp.unlink(missing_ok=True)
                if attempt == 2:
                    raise AdmissionError(f"Unable to download pinned {name}: {last}") from exc
                time.sleep(2 ** attempt)


def retained_candidate(seed: dict, raw: dict, stage3_ids: set[str]) -> dict:
    r = row_payload(raw)
    if normal_id(r["instance_id"]) != seed["upstream_instance_id"]:
        raise AdmissionError("Wrong upstream instance selected")
    if str(r.get("repo", "")).lower() != seed["repository"].lower():
        raise AdmissionError("Repository identity mismatch")
    commit = r.get("commit_to_review")
    if isinstance(commit, str):
        commit = json.loads(commit)
    if not isinstance(commit, dict):
        raise AdmissionError("Missing SWE-CARE commit_to_review object")
    reviewed = checked_sha(commit.get("head_commit"), "commit_to_review.head_commit")
    if not reviewed.startswith(seed["reviewed_sha_prefix_from_catalogue"]):
        raise AdmissionError("Catalogue commit prefix does not match reviewed commit")
    base = checked_sha(r.get("base_commit"), "base_commit")
    comments = r.get("reference_review_comments")
    if isinstance(comments, str):
        comments = json.loads(comments)
    if not isinstance(comments, list) or not all(isinstance(x, dict) for x in comments):
        raise AdmissionError("Missing reference_review_comments array")
    refs = []
    for i, c in enumerate(comments):
        text = c.get("text") or c.get("body") or c.get("comment")
        if not isinstance(text, str) or not text.strip():
            continue
        # original_line and line may refer to different PR revisions. Preserve
        # them, but never silently use one as verified reviewed-sha coordinates.
        refs.append({"source_comment_index": i, "source_path": c.get("path"),
                     "comment": text, "line": c.get("line"), "original_line": c.get("original_line"),
                     "source_comment": c, "anchor_verified": False})
    has_py = any(isinstance(c["source_path"], str) and c["source_path"].endswith(".py") for c in refs)
    return {"candidate_id": seed["candidate_id"], "repository": seed["repository"],
            "pull_number": seed["pull_number"], "pull_url": seed["pull_url"],
            "source": "ccrab_retained", "source_instance_id": r["instance_id"],
            "source_row_sha256": digest(raw), "source_record": raw,
            "base_sha": base, "reviewed_sha": reviewed,
            "merged_commit_hidden": r.get("merged_commit"),
            "source_role": "positive_candidate", "source_reference_comments": refs,
            "has_python_reference": has_py,
            "source_stage3_membership": normal_id(r["instance_id"]) in stage3_ids,
            "source_stage3_membership_means": "Instance appears in author's Stage 3; not proof every retained comment was verified or a local test was executed.",
            "status": "needs_semantic_and_snapshot_audit" if has_py else "blocked_no_python_comment",
            "annotation_provenance": {"human_reviewed_here": False, "agent_reviewed_here": False},
            "context_requirement": "unknown"}

def swr_clean_candidates(rows: list[dict], forbidden_prs: set[tuple[str, int]], limit: int = 64) -> tuple[list[dict], list[dict]]:
    pool, exclusions = [], []
    for r in rows:
        if r.get("change_introduced") is not False:
            continue  # true + E.* is NOT an automatically clean functional PR.
        instance = r.get("instance_id", "")
        repo = r.get("repo", "")
        if not isinstance(instance, str) or not isinstance(repo, str) or not REPO.fullmatch(repo):
            exclusions.append({"id": instance, "reason": "invalid_repo_or_instance"}); continue
        match = re.search(r"-(\d+)$", instance)
        if not match:
            exclusions.append({"id": instance, "reason": "cannot_resolve_pr_number"}); continue
        number = int(match.group(1))
        if (repo.lower(), number) in forbidden_prs:
            exclusions.append({"id": instance, "reason": "overlap_with_positive_pool_do_not_treat_as_clean"}); continue
        if r.get("changes") != []:
            exclusions.append({"id": instance, "reason": "false_label_but_nonempty_changes"}); continue
        try:
            base = checked_sha(r.get("base_commit"), "base_commit")
        except AdmissionError:
            exclusions.append({"id": instance, "reason": "missing_base_sha"}); continue
        # Do not guess pre-review HEAD from all_commits, today's PR HEAD, or
        # the fixing commit. A reviewer selects an exact pr_commits SHA below.
        commits = r.get("pr_commits", [])
        if isinstance(commits, str):
            try: commits = json.loads(commits)
            except json.JSONDecodeError: commits = []
        choices = []
        for c in commits if isinstance(commits, list) else []:
            if isinstance(c, dict):
                value = c.get("sha") or c.get("commit_sha")
                if isinstance(value, str) and SHA.fullmatch(value.lower()):
                    choices.append(value.lower())
        if not choices:
            exclusions.append({"id": instance, "reason": "missing_explicit_pr_commit_shas"}); continue
        pool.append({"candidate_id": "RG-N-" + digest([repo.lower(), number])[:12],
                     "repository": repo, "pull_number": number,
                     "pull_url": f"https://github.com/{repo}/pull/{number}",
                     "source": "swrbench", "source_instance_id": instance,
                     "source_row_sha256": digest(r), "source_record": r,
                     "base_sha": base, "reviewed_sha": None,
                     "allowed_reviewed_sha_candidates": sorted(set(choices)),
                     "source_role": "negative_candidate", "source_reference_comments": [],
                     "source_label": "source_labeled_clean_not_exhaustive_proof",
                     "status": "needs_python_scope_timeline_and_semantic_audit",
                     "annotation_provenance": {"human_reviewed_here": False, "agent_reviewed_here": False},
                     "context_requirement": "unknown"})
    pool.sort(key=lambda c: digest([SEED, c["source_instance_id"]]))
    chosen, used, by_repo = [], set(), Counter()
    for c in pool:
        key = (c["repository"].lower(), c["pull_number"])
        if key in used or by_repo[key[0]] >= 8:
            continue
        used.add(key); by_repo[key[0]] += 1; chosen.append(c)
        if len(chosen) == limit: break
    return chosen, exclusions

def import_sources(cache: Path, output: Path) -> None:
    if output.exists():
        raise AdmissionError("Output already exists; choose a NEW directory, never overwrite a corpus")
    specs = load_json(ROOT / "manifests/sources.lock.json")["files"]
    receipts = {name: check_source_file(source_path(cache, name, spec), spec) for name, spec in specs.items()}
    catalogue = {normal_id(s.strip()) for s in source_path(cache, "ccrab_ids", specs["ccrab_ids"]).read_text().splitlines() if s.strip()}
    seeds = load_json(ROOT / "manifests/candidates40.json")["cases"]
    retained = read_jsonl(source_path(cache, "ccrab_retained", specs["ccrab_retained"]))
    indexed = {}
    for row in retained:
        r = row_payload(row); key = normal_id(r["instance_id"])
        if key in indexed: raise AdmissionError(f"Duplicate retained instance {key}")
        indexed[key] = row
    stage3_ids = {normal_id(row_payload(r)["instance_id"]) for r in read_jsonl(source_path(cache, "ccrab_stage3", specs["ccrab_stage3"]))}
    positives, issues = [], []
    for seed in seeds:
        key = seed["upstream_instance_id"]
        if key not in catalogue or key not in indexed:
            issues.append({"id": key, "reason": "missing_from_pinned_release"}); continue
        try: positives.append(retained_candidate(seed, indexed[key], stage3_ids))
        except (AdmissionError, json.JSONDecodeError) as exc: issues.append({"id": key, "reason": str(exc)})
    negatives, exclusions = swr_clean_candidates(read_jsonl(source_path(cache, "swrbench", specs["swrbench"])),
                      {(s["repository"].lower(), s["pull_number"]) for s in seeds})
    candidates = positives + negatives
    output.mkdir(parents=True)
    write_jsonl(output / "candidates.hydrated.jsonl", candidates)
    template = []
    for c in candidates:
        template.append({"candidate_id": c["candidate_id"], "source_row_sha256": c["source_row_sha256"],
             "decision": "pending", "reviewer": {"kind": None, "name": None, "independent": False},
             "base_sha": c["base_sha"], "reviewed_sha": c["reviewed_sha"],
             "snapshot_timeline_verified": False, "python_scope_verified": False,
             "diff_scope_verified": False, "diff_scope_rationale": "",
             "semantic_label": None, "context_requirement": "unknown", "evidence_files": [],
             "root_cause_family": None, "rationale": "", "expected_findings": [],
             "profile_path": None})
    write_json(output / "audit.template.json", {"audits": template})
    write_json(output / "import-receipt.json", {"status": "draft_not_scoring_gold", "sources": receipts,
              "positive_candidates": len(positives), "negative_candidates": len(negatives),
              "import_issues": issues, "negative_exclusions": exclusions,
              "selection_seed": SEED, "paid_model_calls": 0})
    print(json.dumps({"positive_candidates": len(positives), "negative_candidates": len(negatives),
                      "status": "DRAFT: inspect audit.template.json; no model run authorized"}, ensure_ascii=False))


def safe_path(path: str) -> None:
    if not isinstance(path, str) or not path or path.startswith(("/", "\\")) or "\\" in path or any(ord(c) < 32 for c in path) or ":" in path or any(s in ("", ".", "..") for s in path.split("/")):
        raise AdmissionError("Invalid repository-relative path")

def audit_valid(candidate: dict, audit: dict) -> None:
    if audit.get("decision") != "accept":
        raise AdmissionError("Audit is not accepted")
    if audit.get("source_row_sha256") != candidate["source_row_sha256"]:
        raise AdmissionError("Audit belongs to different source record")
    person = audit.get("reviewer", {})
    if person.get("kind") not in ("human", "agent", "mixed") or not str(person.get("name") or "").strip():
        raise AdmissionError("Explicit reviewer identity/kind required; do not fabricate human review")
    if audit.get("snapshot_timeline_verified") is not True or audit.get("python_scope_verified") is not True:
        raise AdmissionError("Snapshot and Python scope audit required")
    if audit.get("diff_scope_verified") is not True or not str(audit.get("diff_scope_rationale", "")).strip():
        raise AdmissionError("Actual base-to-reviewed diff must match the audited label scope; upstream base can contain unrelated reversions")
    if audit.get("context_requirement") not in ("local", "untouched_file", "multi_hop", "project_invariant"):
        raise AdmissionError("Semantic context requirement must be audited before admission")
    evidence = audit.get("evidence_files")
    if not isinstance(evidence, list) or not evidence:
        raise AdmissionError("Audited evidence files required")
    for path in evidence: safe_path(path)
    if not str(audit.get("rationale", "")).strip() or not str(audit.get("root_cause_family") or "").strip():
        raise AdmissionError("Semantic rationale and family identifier required")
    base = checked_sha(audit.get("base_sha"), "audit.base_sha")
    head = checked_sha(audit.get("reviewed_sha"), "audit.reviewed_sha")
    if base != candidate["base_sha"] or base == head:
        raise AdmissionError("Unexpected base or empty revision pair")
    if candidate.get("reviewed_sha") and head != candidate["reviewed_sha"]:
        raise AdmissionError("Do not change SWE-CARE reviewed revision")
    if candidate.get("allowed_reviewed_sha_candidates") and head not in candidate["allowed_reviewed_sha_candidates"]:
        raise AdmissionError("Reviewed SHA is not an upstream PR commit")
    expected = "defect" if candidate["source_role"] == "positive_candidate" else "clean"
    if audit.get("semantic_label") != expected:
        raise AdmissionError("Changed/ambiguous labels require another version, not silent relabeling")
    findings = audit.get("expected_findings")
    if not isinstance(findings, list) or (expected == "defect" and not findings) or (expected == "clean" and findings):
        raise AdmissionError("Finding list inconsistent with audited label")
    ids = set()
    for finding in findings:
        if not all(isinstance(finding.get(k), str) and finding[k].strip() for k in ("id", "claim", "trigger", "impact", "path")):
            raise AdmissionError("Gold requires id, claim, trigger, impact and source path")
        if finding["id"] in ids: raise AdmissionError("Duplicate gold ID")
        ids.add(finding["id"]); safe_path(finding["path"])
        if finding.get("severity") not in ("low", "medium", "high", "critical"):
            raise AdmissionError("Audited severity required")
        if finding["path"] not in evidence: raise AdmissionError("Gold anchor must belong to audited evidence files")
        if not finding["path"].endswith(".py"): raise AdmissionError("V1 gold must have a Python issue anchor")
        start, end = finding.get("start_line"), finding.get("end_line")
        if type(start) is not int or type(end) is not int or not (1 <= start <= end):
            raise AdmissionError("Verified reviewed-revision line range required")
        if finding.get("revision", "head") != "head":
            raise AdmissionError("V1 fixes gold issue anchors to the reviewed HEAD; base evidence can be supplemental")


def git_call(repo_path: Path, args: list[str], timeout: int = 120) -> bytes:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_TERMINAL_PROMPT": "0", "GIT_NO_REPLACE_OBJECTS": "1", "GIT_LFS_SKIP_SMUDGE": "1"})
    cmd = ["git", "-c", "safe.directory=", "-c", f"safe.directory={repo_path}", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
           "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "-C", str(repo_path), *args]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=timeout)
    if result.returncode:
        # No credentials are embedded in URL or printed. Diagnostic is bounded.
        raise AdmissionError(result.stderr.decode("utf-8", "replace")[-1200:])
    return result.stdout


def profile_one(candidate: dict, audit: dict, cache: Path) -> dict:
    # No checkout, source execution, build system, test, parser or graph needed.
    audit_valid(candidate, audit)
    repository = candidate["repository"]
    if not REPO.fullmatch(repository): raise AdmissionError("Invalid GitHub repository")
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / (digest(repository.lower())[:20] + ".git")
    if not path.exists():
        path.mkdir()
        git_call(path, ["init", "--bare", "--template=", "."])
        git_call(path, ["remote", "add", "origin", f"https://github.com/{repository}.git"])
    if git_call(path, ["remote", "get-url", "origin"]).decode().strip() != f"https://github.com/{repository}.git":
        raise AdmissionError("Git cache origin identity mismatch")
    base, head = audit["base_sha"], audit["reviewed_sha"]
    for sha in (base, head):
        try: git_call(path, ["cat-file", "-e", sha + "^{commit}"])
        except AdmissionError: git_call(path, ["fetch", "--no-tags", "--depth=1", "origin", sha], 300)
    stats, head_sizes, head_texts = {}, {}, {}
    for revision, sha in (("base", base), ("head", head)):
        listing = git_call(path, ["ls-tree", "-r", "-l", "-z", sha])
        files = []
        for entry in listing.split(b"\0"):
            if not entry: continue
            meta, filename = entry.split(b"\t", 1)
            mode, kind, obj, size = meta.split()
            filename_text = filename.decode("utf-8", "strict"); safe_path(filename_text)
            size_number = int(size) if size != b"-" else 0
            files.append({"path": filename_text, "size": size_number, "mode": mode.decode(), "kind": kind.decode()})
            if revision == "head": head_sizes[filename_text] = size_number
        total = sum(f["size"] for f in files)
        stats[revision] = {"paths": len(files), "total_blob_bytes": total,
          "python_files": sum(f["path"].endswith(".py") for f in files),
          "oversized_files": [f["path"] for f in files if f["size"] > 1048576],
          "symlinks_or_submodules": [f["path"] for f in files if f["mode"] in ("120000", "160000")],
          "fits_current_snapshot_limits": len(files) <= 10000 and total <= 104857600}
    changed = [p.decode("utf-8", "strict") for p in git_call(path, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, head]).split(b"\0") if p]
    for p in changed: safe_path(p)
    anchors = []
    for f in audit["expected_findings"]:
        p = f["path"]
        if p not in head_sizes or head_sizes[p] > 1048576:
            raise AdmissionError("Gold Python source is missing/oversized")
        raw = git_call(path, ["show", head + ":" + p])
        text = raw.decode("utf-8-sig").replace("\r\n", "\n")
        if "\0" in text: raise AdmissionError("Binary gold source")
        lines = text.splitlines()
        if f["end_line"] > len(lines): raise AdmissionError("Gold line range exceeds reviewed source")
        span = "\n".join(lines[f["start_line"]-1:f["end_line"]])
        anchors.append({"id": f["id"], "path": p, "start_line": f["start_line"], "end_line": f["end_line"],
                        "source_span_sha256": hashlib.sha256(span.encode()).hexdigest()})
    return {"candidate_id": candidate["candidate_id"], "source_row_sha256": candidate["source_row_sha256"],
            "audit_sha256": digest(audit), "repository": repository, "base_sha": base, "reviewed_sha": head,
            "statistics": stats, "changed_paths": changed, "python_changed_paths": [p for p in changed if p.endswith(".py")],
            "gold_anchors": anchors,
            "admitted": all(x["fits_current_snapshot_limits"] for x in stats.values()) and 0 < len(changed) <= 200 and any(p.endswith(".py") for p in changed),
            "source_executed": False, "scope": "Git object and range checks only; semantic audit still depends on declared reviewer"}


def freeze(candidates: list[dict], audits: list[dict], profile_dir: Path, output: Path) -> dict:
    if output.exists(): raise AdmissionError("Use a new freeze output directory")
    cmap = {c["candidate_id"]: c for c in candidates}
    if len(cmap) != len(candidates): raise AdmissionError("Duplicate candidates")
    if len({a["candidate_id"] for a in audits}) != len(audits): raise AdmissionError("Duplicate audits")
    accepted, excluded = [], []
    for a in audits:
        c = cmap.get(a["candidate_id"])
        if not c: raise AdmissionError("Audit references unknown candidate")
        if a.get("decision") != "accept": continue
        try:
            audit_valid(c, a)
            p = load_json(profile_dir / (c["candidate_id"] + ".json"))
            if p.get("source_row_sha256") != c["source_row_sha256"] or p.get("audit_sha256") != digest(a) or p.get("admitted") is not True:
                raise AdmissionError("Missing, stale or failed repository preflight")
            if any(p.get(k) != a.get(k) for k in ("base_sha", "reviewed_sha")) or p.get("repository") != c["repository"] or p.get("candidate_id") != c["candidate_id"]:
                raise AdmissionError("Profile identity/revisions do not match audited task")
            accepted.append((c, a, p))
        except (AdmissionError, OSError, json.JSONDecodeError) as exc:
            excluded.append({"candidate_id": c["candidate_id"], "reason": str(exc)})
    # Labels govern composition, not any T0/G0/G1 results. One PR at most once.
    ranked = sorted(accepted, key=lambda x: digest([SEED, x[0]["source_instance_id"]]))
    selected, quotas, repos, seen = [], {"defect": 24, "clean": 16}, Counter(), set()
    # Round-robin across repos for diversity while using one preregistered rank.
    while sum(quotas.values()):
        options = [x for x in ranked if quotas[x[1]["semantic_label"]] and
                   (x[0]["repository"].lower(), x[0]["pull_number"]) not in seen and repos[x[0]["repository"].lower()] < 6]
        if not options: break
        options.sort(key=lambda x: (repos[x[0]["repository"].lower()], 0 if x[0].get("source_stage3_membership") is True else 1, digest([SEED, x[0]["source_instance_id"]])))
        c, a, p = options[0]; label = a["semantic_label"]; repo = c["repository"].lower()
        seen.add((repo, c["pull_number"])); repos[repo] += 1; quotas[label] -= 1; selected.append((c, a, p))
    if sum(quotas.values()) or len(repos) < 6:
        raise AdmissionError(f"Not enough audited data for 40: missing={quotas}, repositories={len(repos)}, invalid={excluded[:5]}. No invented cases or automatic relabeling.")
    tasks, gold, receipts = [], [], []
    for i, (c, a, p) in enumerate(selected, 1):
        case_id = f"RG40-{i:03d}"
        tasks.append({"case_id": case_id, "repository": c["repository"], "repository_url": f"https://github.com/{c['repository']}.git",
                       "base_sha": a["base_sha"], "reviewed_sha": a["reviewed_sha"],
                       "language": "Python", "review_context_policy": "repository-and-diff-only; no post-review discussion or hidden gold"})
        gold.append({"case_id": case_id, "candidate_id": c["candidate_id"], "expected_label": a["semantic_label"],
                     "expected_findings": a["expected_findings"], "root_cause_family": a["root_cause_family"],
                     "context_requirement": a["context_requirement"], "evidence_files": a["evidence_files"],
                     "rationale": a["rationale"], "annotation_provenance": a["reviewer"],
                     "source_row_sha256": c["source_row_sha256"], "source_dataset": c["source"],
                     "source_instance_id": c["source_instance_id"], "source_record": c["source_record"]})
        receipts.append({"case_id": case_id, "audit": a, "profile": p})
    output.mkdir(parents=True)
    write_jsonl(output / "public/tasks.jsonl", tasks)
    write_jsonl(output / "hidden/gold.jsonl", gold)
    write_json(output / "audit/receipts.json", receipts)
    manifest = {"schema_version": 1, "corpus_id": "mergewarden-real-python40-v1", "cases": 40,
                "positive": 24, "negative": 16, "repositories": dict(repos), "seed": SEED,
                "tasks_sha256": digest(tasks), "gold_sha256": digest(gold),
                "human_reviewed_count": sum(a["reviewer"]["kind"] in ("human", "mixed") for _, a, _ in selected),
                "source_tests_executed_here": False, "paid_model_calls": 0,
                "status": "frozen_to_declared_audit_level_not_independent_leaderboard", "excluded": excluded}
    write_json(output / "manifest.lock.json", manifest)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("fetch"); s.add_argument("--cache", type=Path, required=True)
    s.add_argument("--only", nargs="+", choices=list(load_json(ROOT/"manifests/sources.lock.json")["files"]))
    s = sub.add_parser("import"); s.add_argument("--cache", type=Path, required=True); s.add_argument("--out", type=Path, required=True)
    s = sub.add_parser("profile"); s.add_argument("--candidates", type=Path, required=True); s.add_argument("--audits", type=Path, required=True)
    s.add_argument("--git-cache", type=Path, required=True); s.add_argument("--out", type=Path, required=True)
    s = sub.add_parser("freeze"); s.add_argument("--candidates", type=Path, required=True); s.add_argument("--audits", type=Path, required=True)
    s.add_argument("--profiles", type=Path, required=True); s.add_argument("--out", type=Path, required=True)
    opts = parser.parse_args()
    if opts.command == "fetch": fetch_sources(opts.cache, opts.only)
    elif opts.command == "import": import_sources(opts.cache, opts.out)
    else:
        candidates = read_jsonl(opts.candidates); audits = load_json(opts.audits)["audits"]
        if opts.command == "freeze": print(json.dumps(freeze(candidates, audits, opts.profiles, opts.out), ensure_ascii=False, indent=2))
        else:
            cmap = {c["candidate_id"]: c for c in candidates}
            opts.out.mkdir(parents=True, exist_ok=True)
            errors = []
            for a in audits:
                if a.get("decision") != "accept": continue
                key = a["candidate_id"]
                try:
                    result = profile_one(cmap[key], a, opts.git_cache)
                    write_json(opts.out/(key+".json"), result)
                except (AdmissionError, OSError, subprocess.TimeoutExpired, UnicodeError) as exc:
                    errors.append({"candidate_id": key, "reason": str(exc)})
            write_json(opts.out/"errors.json", errors)
            print(json.dumps({"errors": errors}, ensure_ascii=False))
            if errors: raise SystemExit(2)

if __name__ == "__main__":
    try: main()
    except (AdmissionError, OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr); raise SystemExit(2)
