/*
 * @Author: Dorad, ddxi@qq.com
 * @Date: 2023-04-16 17:05:49 +02:00
 * @LastEditors: Dorad, ddxi@qq.com
 * @LastEditTime: 2023-04-16 21:18:46 +02:00
 * @FilePath: \test\test.js
 * @Description: 
 * 
 * Copyright (c) 2023 by Dorad (ddxi@qq.com), All Rights Reserved.
 */


import fs from "fs";
import * as notion from "../src/notion.js";

console.info("Notion2markdown-action test started...");
if (!fs.existsSync("./config.json")) {
    console.error("请先创建配置文件");
}
// load 

const configRaw = fs.readFileSync("./config.json");
const config = JSON.parse(configRaw);
// update last_sync_datetime = 24 hour ago
config.last_sync_datetime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

console.info("config loaded:", config);
// const config = ;
(async function () {
    notion.init(config);
    // get output
    const out = await notion.sync();
    console.info(`Notion2markdown-action finished, queried: ${out.queried}, handled: ${out.handled} and deleted: ${out.deleted}`)
})();

