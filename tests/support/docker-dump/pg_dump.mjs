#!/usr/bin/env node
import { runInContainer } from "./run.mjs";

runInContainer("postgres", "pg_dump", 5432, ["PGPASSWORD", "PGSSLMODE"]);
