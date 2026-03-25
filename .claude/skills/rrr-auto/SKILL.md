---
name: rrr-auto
description: Proactive code review. When the user completes a meaningful coding task or asks for a review, invoke /rrr automatically — but only if this project has opted in.
user-invocable: false
---

!`[ -e .rrr ] && printf "This project has opted into automatic code review.\n\nAfter the user completes a meaningful coding task, invoke /rrr proactively to review their changes.\n"`
