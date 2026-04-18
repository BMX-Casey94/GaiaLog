# Security Policy

## Supported branch

Security fixes are expected to target the active default branch and the currently maintained deployment path.

## Reporting a vulnerability

Please do not file public GitHub issues for security vulnerabilities.

Instead:

1. Use GitHub private vulnerability reporting if it is enabled for the repository.
2. If private reporting is not available, contact the maintainer privately through an agreed non-public channel before any public disclosure.

Please include:

- a clear description of the issue
- affected files, routes, or flows
- reproduction steps
- impact assessment
- any suggested remediation

## Response expectations

- initial acknowledgement target: within 5 business days
- status updates: as work progresses
- coordinated disclosure: after a fix or mitigation is ready

## Scope of particular interest

Please report issues involving:

- wallet WIF handling
- transaction signing or broadcast logic
- overlay lookup or submit endpoints
- admin authentication and session handling
- internal, debug, warmup, or test endpoints that could mutate state or expose operational data
- Supabase or database privilege boundaries
- secret exposure in docs, examples, CI, or client-side code

## Safe testing expectations

- do not publicly disclose exploitable details before remediation
- avoid destructive testing against live infrastructure
- do not access or alter data that you do not own or control
