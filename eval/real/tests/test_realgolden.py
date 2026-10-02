"""All fixtures below are synthetic parser/guard tests, NOT benchmark examples."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'tools/realgolden.py'
spec = importlib.util.spec_from_file_location('realgolden', MODULE)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class KitTests(unittest.TestCase):
    def seed(self):
        return {'candidate_id':'SYNTHETIC-C1','upstream_instance_id':'example__repo-1@bbbbbbb',
                'repository':'example/repo','pull_number':1,'pull_url':'https://github.com/example/repo/pull/1',
                'reviewed_sha_prefix_from_catalogue':'bbbbbbb'}
    def row(self):
        return {'instance_id':'example__repo-1@bbbbbbb','repo':'example/repo','base_commit':'a'*40,
                'commit_to_review':{'head_commit':'b'*40},'reference_review_comments':[
                {'text':'SYNTHETIC reference for contract tests only','path':'a.py','line':None,'original_line':9}],
                'merged_commit':'c'*40}
    def candidate(self):
        return m.retained_candidate(self.seed(),self.row(),set())
    def audit(self,c=None):
        c=c or self.candidate()
        return {'candidate_id':c['candidate_id'],'source_row_sha256':c['source_row_sha256'],'decision':'accept',
                'reviewer':{'kind':'agent','name':'SYNTHETIC test','independent':False},'base_sha':'a'*40,'reviewed_sha':'b'*40,
                'snapshot_timeline_verified':True,'python_scope_verified':True,'semantic_label':'defect',
                'diff_scope_verified':True,'diff_scope_rationale':'SYNTHETIC diff matches label scope',
                'context_requirement':'untouched_file','evidence_files':['a.py'],'root_cause_family':'SYNTHETIC family',
                'rationale':'SYNTHETIC expected behavior for guard testing',
                'expected_findings':[{'id':'SYNTHETIC-f1','claim':'x','trigger':'x','impact':'x','path':'a.py','start_line':1,'end_line':1,'severity':'medium'}]}
    def test_catalogue_has_40_unique_known_references(self):
        obj=m.load_json(m.ROOT/'manifests/candidates40.json');rows=obj['cases']
        self.assertEqual(len(rows),40);self.assertEqual(len({r['upstream_instance_id'] for r in rows}),40)
        self.assertEqual(len({r['repository'] for r in rows}),12)
        self.assertTrue(all(r['expected_label'] is None and r['reviewed_sha'] is None for r in rows))
    def test_source_hash_and_size(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'fixture';raw=b'SYNTHETIC DATA\n';p.write_bytes(raw)
            spec={'size_bytes':len(raw),'git_blob_sha1':hashlib.sha1(f'blob {len(raw)}\0'.encode()+raw).hexdigest()}
            self.assertEqual(m.check_source_file(p,spec)['sha256'],hashlib.sha256(raw).hexdigest())
            p.write_bytes(raw.replace(b'DATA',b'FAIL'))
            with self.assertRaises(m.AdmissionError):m.check_source_file(p,spec)
    def test_normal_id(self):
        self.assertEqual(m.normal_id('reviewbench/Example__Repo-1@AbCd123'),'example__repo-1@abcd123')
    def test_reviewed_not_merged_sha(self):
        c=self.candidate();self.assertEqual(c['reviewed_sha'],'b'*40);self.assertNotEqual(c['reviewed_sha'],c['merged_commit_hidden'])
    def test_stage3_membership_is_not_comment_verification(self):
        c=m.retained_candidate(self.seed(),self.row(),{'example__repo-1@bbbbbbb'})
        self.assertTrue(c['source_stage3_membership']);self.assertFalse(c['source_reference_comments'][0]['anchor_verified'])
    def test_prefix_mismatch_fails(self):
        r=self.row();r['commit_to_review']['head_commit']='d'*40
        with self.assertRaises(m.AdmissionError):m.retained_candidate(self.seed(),r,set())
    def test_nonpython_comment_blocked(self):
        r=self.row();r['reference_review_comments'][0]['path']='a.ts'
        self.assertEqual(m.retained_candidate(self.seed(),r,set())['status'],'blocked_no_python_comment')
    def test_dont_reuse_original_line_silently(self):
        c=self.candidate();self.assertIsNone(c['source_reference_comments'][0]['line']);self.assertFalse(c['source_reference_comments'][0]['anchor_verified'])
    def test_schema_drift_fails(self):
        with self.assertRaises(m.AdmissionError):m.row_payload({'identifier':'ambiguous'})
    def test_swr_only_explicit_clean_and_no_overlap(self):
        rows=[{'instance_id':'example__repo-1','repo':'example/repo','change_introduced':False,'changes':[],'base_commit':'a'*40,'pr_commits':[{'sha':'b'*40}]}]
        result,_=m.swr_clean_candidates(rows,set());self.assertEqual(len(result),1);self.assertIsNone(result[0]['reviewed_sha'])
        result,_=m.swr_clean_candidates(rows,{('example/repo',1)});self.assertEqual(result,[])
        rows[0]['change_introduced']='false';self.assertEqual(m.swr_clean_candidates(rows,set())[0],[])
    def test_evolvability_is_not_clean(self):
        r={'instance_id':'example__repo-1','repo':'example/repo','change_introduced':True,'changes':[{'change_type':'E.3'}]}
        self.assertEqual(m.swr_clean_candidates([r],set())[0],[])
    def test_audit_must_bind_to_source(self):
        c=self.candidate();a=self.audit(c);m.audit_valid(c,a);a['source_row_sha256']='other'
        with self.assertRaises(m.AdmissionError):m.audit_valid(c,a)
    def test_pending_cannot_freeze(self):
        c=self.candidate();a=self.audit(c);a['decision']='pending'
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(m.AdmissionError):m.freeze([c],[a],Path(d),Path(d)/'out')
    def test_missing_gold_and_reviewer_rejected(self):
        c=self.candidate()
        for change in ({'expected_findings':[]},{'reviewer':{'kind':None,'name':''}},{'snapshot_timeline_verified':False}):
            a=self.audit(c);a.update(change)
            with self.assertRaises(m.AdmissionError):m.audit_valid(c,a)
    def test_path_and_sha_guards(self):
        for p in ('../x.py','/x.py','C:\\x.py','x\\y.py','a/../x.py','a//x.py','a/./x.py','a\nx.py'):
            with self.assertRaises(m.AdmissionError):m.safe_path(p)
        with self.assertRaises(m.AdmissionError):m.checked_sha('bbbbbbb','sha')
    def test_truthy_strings_and_unchecked_diff_scope_cannot_be_audit(self):
        c=self.candidate()
        for change in ({'snapshot_timeline_verified':'true'},{'diff_scope_verified':False},{'diff_scope_rationale':''},{'context_requirement':'unknown'},{'evidence_files':[]}):
            a=self.audit(c);a.update(change)
            with self.assertRaises(m.AdmissionError):m.audit_valid(c,a)
    def test_missing_changes_field_is_not_explicit_clean(self):
        r={'instance_id':'example__repo-1','repo':'example/repo','change_introduced':False,'base_commit':'a'*40,'pr_commits':[{'sha':'b'*40}]}
        self.assertEqual(m.swr_clean_candidates([r],set())[0],[])
    def test_severity_and_audited_evidence_required(self):
        c=self.candidate();a=self.audit(c);del a['expected_findings'][0]['severity']
        with self.assertRaises(m.AdmissionError):m.audit_valid(c,a)
        a=self.audit(c);a['evidence_files']=['other.py']
        with self.assertRaises(m.AdmissionError):m.audit_valid(c,a)
    def test_profile_for_another_revision_cannot_freeze(self):
        c=self.candidate();a=self.audit(c)
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)
            m.write_json(p/(c['candidate_id']+'.json'),{'source_row_sha256':c['source_row_sha256'],'audit_sha256':m.digest(a),'admitted':True,'candidate_id':c['candidate_id'],'repository':c['repository'],'base_sha':'c'*40,'reviewed_sha':a['reviewed_sha']})
            with self.assertRaisesRegex(m.AdmissionError,'identity/revisions'):m.freeze([c],[a],p,p/'out')
    def test_freeze_40_and_keep_labels_hidden(self):
        candidates=[];audits=[]
        with tempfile.TemporaryDirectory() as d:
            prof=Path(d)/'profiles';prof.mkdir()
            for i in range(40):
                c=self.candidate();c.update(candidate_id=f'SYNTHETIC-{i}',repository=f'example/repo{i%8}',pull_number=i+1,source_instance_id=f'synthetic-{i}',source_role='positive_candidate' if i<24 else 'negative_candidate')
                a=self.audit(c);a.update(candidate_id=c['candidate_id'],root_cause_family=f'SYNTHETIC family {i}')
                if i>=24:a.update(semantic_label='clean',expected_findings=[])
                candidates.append(c);audits.append(a)
                m.write_json(prof/(c['candidate_id']+'.json'),{'source_row_sha256':c['source_row_sha256'],'audit_sha256':m.digest(a),'admitted':True,'candidate_id':c['candidate_id'],'repository':c['repository'],'base_sha':a['base_sha'],'reviewed_sha':a['reviewed_sha']})
            out=Path(d)/'frozen';result=m.freeze(candidates,audits,prof,out)
            self.assertEqual(result['cases'],40);self.assertEqual(result['human_reviewed_count'],0)
            tasks=m.read_jsonl(out/'public/tasks.jsonl')
            self.assertTrue(all('expected_label' not in r and 'expected_findings' not in r and 'source_record' not in r for r in tasks))
            self.assertEqual(len(m.read_jsonl(out/'hidden/gold.jsonl')),40)
            with self.assertRaises(m.AdmissionError):m.freeze(candidates,audits,prof,out)

if __name__=='__main__':unittest.main(verbosity=2)
