# Claude Code Configuration

## GitHub CLI

`gh` CLI is authenticated and works for all GitHub operations (PRs, merges, checks).

```bash
# Create PR
gh pr create --title "..." --base master --body "..."

# Merge PR (squash)
gh pr merge <number> --squash --delete-branch

# List PRs
gh pr list --repo proseso-sys-admin/ap-bill-worker
```

## Notes

- Always push to a `claude/<name>-<session-id>` branch; direct pushes to `master` return 403.

---

## PR Checks

`cloudbuild-pr.yaml` validates code on every pull request:
- `npm ci` — install dependencies
- Syntax check on entry point

Merges to `master` are blocked until PR checks pass (branch protection enabled).

