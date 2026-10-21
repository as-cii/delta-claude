---
category: Fixed
---

A subagent started by another subagent is now recorded even when its parent's transcript can't be read. A message to a Delta thread is no longer reported as delivered when Claude started no subagent for it, and a session started after `/clear` or a resume is told which threads it can message. While the connection to Delta retries, the band no longer shows a connection that never came up as live. Error messages no longer start with "Error:".
