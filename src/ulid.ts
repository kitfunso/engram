// Thin re-export of a monotonic ULID factory. IDs generated in the same
// millisecond from the same factory instance still sort strictly increasing
// (the `ulid` package increments the random part instead of re-rolling it).
// One shared factory per process keeps that monotonic guarantee across all
// callers (memories, versions, recall_log, sessions, turns all use ULIDs).

import { monotonicFactory } from "ulid";

export const newUlid = monotonicFactory();
