# Claude Code Configuration

## GitHub API Access

A GitHub classic PAT with `repo` scope is needed for API calls (creating PRs, etc.).
The user will provide the token at the start of each session, or store it in a local
`.env` file (gitignored) as `GITHUB_TOKEN=<token>`.

### Creating a PR

```bash
curl -s -X POST "https://api.github.com/repos/proseso-sys-admin/ap-bill-worker/pulls" \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "...", "head": "branch-name", "base": "master", "body": "..."}'
```

## Notes

- The git remote uses a local proxy that only supports git protocol — `gh` CLI is unavailable.
- Always push to a `claude/<name>-<session-id>` branch; direct pushes to `master` return 403.
