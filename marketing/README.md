# MergeWarden V2 project site

This directory contains the static V2 product page. It shares the repository's
current CLI, CodeGraph and Review Skills documentation and evaluation results.
The page does not run the review engine or collect model credentials.

## Preview

From the repository root:

```sh
python -m http.server 4174 --directory marketing
```

Open `http://localhost:4174`. Python is only needed for this optional local
preview; the deployed HTML, CSS and JavaScript require no build or runtime.

## Deployment

Keep `marketing` as the existing Vercel project's root directory. Serve it as a
static site with no install or build command. The review engine remains a local
Node.js application; its CLI and MCP setup are documented in the root README
and `integrations/mcp/README.md`.
