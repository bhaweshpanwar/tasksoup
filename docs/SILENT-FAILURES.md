# Silent Failures

## Double Claim

### How it could happen
If concurrent workers select the next available queued job using an uncoordinated SELECT followed by an UPDATE, multiple workers can read the same row before either modifies it. Both workers then transition the same job to running and execute duplicate side effects.

### How I checked it
TODO(human)

### Evidence (files)
- [results/v1-atomic.txt](../results/v1-atomic.txt)
- [results/chaos/mutant-naiveclaim-run1.txt](../results/chaos/mutant-naiveclaim-run1.txt)

### Not checked
TODO(human)

## Zombie Worker

### How it could happen
A worker executing a job may experience a process pause, GC freeze, or network partition that exceeds its lease duration, causing the reaper to requeue the job for another worker. If the original worker resumes without validating an active lease or fencing token, both the stale worker and the new worker commit duplicate effects.

### How I checked it
TODO(human)

### Evidence (files)
- [results/v2-freeze.txt](../results/v2-freeze.txt)
- [results/v3-freeze.txt](../results/v3-freeze.txt)
- [results/v3-freeze-rejections.txt](../results/v3-freeze-rejections.txt)
- [results/chaos/mutant-nofence-run1.txt](../results/chaos/mutant-nofence-run1.txt)

### Not checked
TODO(human)

## Cancel/Complete Race

### How it could happen
A cancellation request may arrive at the API while a worker is actively processing the job and preparing to commit. If the completion transaction does not verify that the job is still in a running state, the worker could commit its side effects for a job that was already reported as cancelled.

### How I checked it
TODO(human)

### Evidence (files)
- [results/v4-cancel.txt](../results/v4-cancel.txt)

### Not checked
TODO(human)

## Duplicate on Request Retry

### How it could happen
When a client sends a job creation request and suffers a network timeout before receiving the response, it will retry the request. Without an idempotency mechanism and unique constraints, the retry inserts a duplicate job row with identical parameters.

### How I checked it
TODO(human)

### Evidence (files)
- [results/v4-normal.txt](../results/v4-normal.txt)

### Not checked
TODO(human)

## Transaction Isolation Level

### How it could happen
Under Read Committed isolation, non-repeatable reads or phantom reads could theoretically allow concurrent statements to observe inconsistent snapshot states between reading and updating. If statements do not explicitly lock rows or atomically update with row-level locks, race conditions can produce inconsistent claim logs or status transitions.

### How I checked it
TODO(human)

### Evidence (files)
- [results/v1-atomic.txt](../results/v1-atomic.txt)
- [results/v3-freeze.txt](../results/v3-freeze.txt)

### Not checked
TODO(human)

## Clock Skew

### How it could happen
If worker system clocks and database server clocks drift out of synchronization, lease calculations computed on worker nodes could expire earlier or later than intended. A worker relying on local wall-clock time might consider its lease valid when the database reaper has already expired and reassigned the job.

### How I checked it
TODO(human)

### Evidence (files)
TODO(human)

### Not checked
TODO(human)
