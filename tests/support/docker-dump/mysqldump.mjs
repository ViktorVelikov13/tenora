#!/usr/bin/env node
import { runInContainer } from "./run.mjs";

runInContainer("mysql", "mysqldump", 3306, ["MYSQL_PWD"]);
