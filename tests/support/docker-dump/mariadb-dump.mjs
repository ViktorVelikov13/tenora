#!/usr/bin/env node
import { runInContainer } from "./run.mjs";

runInContainer("mariadb", "mariadb-dump", 3306, ["MYSQL_PWD"]);
