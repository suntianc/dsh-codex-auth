# Reuse the Codex CLI login state

Status: **accepted**

The official Codex CLI remains the sole login authority, and `dsh-codex-auth` reads and refreshes that live state instead of creating a second OAuth store. This preserves the project's defining one-login behavior, but rotating refresh tokens make simple atomic last-writer-wins writes insufficient; all plugin consumers therefore share a Host-side coordinator with in-process singleflight, a DSH cross-process lock, locked re-reads, and recovery from a newer same-account file after refresh-token reuse. The official CLI does not participate in the plugin lock, so the guarantee is recoverability rather than absolute cross-client serialization.

An independent Harness-owned OAuth store was rejected because it requires a second login and duplicates the Codex authority. Access-token-only reuse was rejected because an idle CLI would leave Harness with an expired token and no reliable service.
