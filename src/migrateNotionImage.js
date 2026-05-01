/*
 * @Author: Dorad, ddxi@qq.com
 * @Date: 2023-09-03 14:22:38 +08:00
 * @LastEditors: Dorad, ddxi@qq.com
 * @LastEditTime: 2023-09-04 11:13:42 +08:00
 * @FilePath: \src\migrateNotionImage.js
 * @Description:
 *
 * Copyright (c) 2023 by Dorad (ddxi@qq.com), All Rights Reserved.
 */

import path from "path";
import sizeOf from "image-size";
import imagemin from "imagemin";
import imageSize from "image-size";
import imageminPngquant from "imagemin-pngquant";
import imageminJpegtran from "imagemin-jpegtran";
import imageminGifsicle from "imagemin-gifsicle";

const urlReg =
    /^https:\/\/.*?amazonaws\.com\/.+\.(?:jpg|jpeg|bmp|tif|tiff|svg|png|gif|webp)\?.+/;
const uuidReg = /[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}/g;

/**
 * 解析 Notion 图片 URL，提取 uuid 和扩展名
 */
function parseNotionUrl(url) {
    const uuid = url.match(uuidReg)?.pop();
    let ext = url.split("?")[0].split(".").pop()?.toLowerCase();
    ext = ext === "jpeg" ? "jpg" : ext;
    ext = ext === "tiff" ? "tif" : ext;
    return { uuid, ext };
}

/**
 * 批量迁移 Notion 图片：
 * 1. 并行检查哪些图片已存在于图床
 * 2. 并行下载所有需要上传的图片
 * 3. 一次性批量上传，避免 PicGo 内部状态竞争
 *
 * @param {*} ctx - PicGo 实例
 * @param {string[]} urls - 图片 URL 列表
 * @returns {Promise<Map<string, string>>} 原始 URL -> 新 URL 的映射
 */
async function batchMigrateNotionImages(ctx, urls) {
    if (!urls || urls.length === 0) return new Map();

    const base_url = ctx?.getConfig("pic-base-url") || null;

    // 阶段一：并行检查每张图片，确定哪些需要上传、哪些已存在
    const preparedItems = await Promise.all(
        urls.map(async (url) => {
            // 非 Notion 临时图片，直接跳过
            if (!urlReg.test(url)) {
                return { url, resolvedUrl: url, needsUpload: false };
            }

            const { uuid, ext } = parseNotionUrl(url);

            // 如果配置了 base_url，先检查图片是否已存在于图床
            if (base_url) {
                const picUrl = new URL(`${uuid}.${ext}`, base_url).href;
                if (await checkPicExist(ctx, picUrl)) {
                    // ctx.log.info(`Image ${picUrl} already exists, skip upload`);
                    return { url, resolvedUrl: picUrl, needsUpload: false };
                }
            }

            // 需要上传：下载图片并准备上传
            try {
                let imageItem = await handlePicFromURL(ctx, url);
                if (!imageItem) {
                    ctx.log.error(`Failed to download image: ${url}`);
                    return { url, resolvedUrl: url, needsUpload: false };
                }

                // 按需压缩
                if (
                    ctx?.getConfig("compress") &&
                    ["jpg", "png", "gif"].includes(ext)
                ) {
                    imageItem = await compressPic(imageItem);
                }

                imageItem.fileName = `${uuid}.${ext}`;
                return { url, resolvedUrl: null, needsUpload: true, imageItem };
            } catch (e) {
                ctx.log.error(`Failed to prepare image ${url}: ${e}`);
                return { url, resolvedUrl: url, needsUpload: false };
            }
        }),
    );

    // 阶段二：将所有待上传图片合并为单次 ctx.upload 调用
    const toUpload = preparedItems.filter((item) => item.needsUpload);
    if (toUpload.length > 0) {
        ctx.log.info(`Batch uploading ${toUpload.length} image(s)...`);
        try {
            const imageItems = toUpload.map((item) => item.imageItem);
            const results = await ctx.upload(imageItems);

            if (results && Array.isArray(results)) {
                toUpload.forEach((item, index) => {
                    if (results[index] && results[index].imgUrl) {
                        item.resolvedUrl = results[index].imgUrl;
                        ctx.log.info(
                            `Upload success: ${results[index].imgUrl}`,
                        );
                    } else {
                        item.resolvedUrl = item.url; // 回退到原始 URL
                        ctx.log.error(`Upload failed for: ${item.url}`);
                    }
                });
            } else {
                // 上传结果异常，全部回退
                toUpload.forEach((item) => {
                    item.resolvedUrl = item.url;
                    ctx.log.error(`Unexpected upload result for: ${item.url}`);
                });
            }
        } catch (e) {
            ctx.log.error(`Batch upload failed: ${e}`);
            toUpload.forEach((item) => {
                item.resolvedUrl = item.url;
            });
        }
    }

    // 构建 URL 映射表
    const urlMap = new Map();
    preparedItems.forEach((item) => {
        urlMap.set(item.url, item.resolvedUrl || item.url);
    });
    return urlMap;
}

/**
 * 单张图片迁移（兼容旧调用，内部使用批量逻辑）
 */
async function migrateNotionImageFromURL(ctx, url) {
    const urlMap = await batchMigrateNotionImages(ctx, [url]);
    return urlMap.get(url) || url;
}

// 检查图片是否存在
async function checkPicExist(ctx, picUrl) {
    try {
        const res = await ctx.request({
            method: "HEAD",
            url: picUrl,
            resolveWithFullResponse: true,
        });
        return res.status === 200;
    } catch (e) {
        return false;
    }
}

// 从URL获取图片信息
async function handlePicFromURL(ctx, url) {
    try {
        if (url.includes("data:image/svg+xml")) {
            let data = url.replace("data:image/svg+xml;utf8,", "");
            return {
                buffer: Buffer.from(decodeURIComponent(data), "utf-8"),
                fileName: `${new Date().getTime()}.svg`,
                extname: ".svg",
                origin: url,
            };
        }
        const buffer = await ctx.request({
            url,
            encoding: null,
            responseType: "arraybuffer",
        });
        const fileName = path.basename(url).split("?")[0].split("#")[0];
        const imgSize = getImageSize(buffer);
        return {
            buffer,
            fileName,
            width: imgSize.width,
            height: imgSize.height,
            extname: `.${imgSize.type || "png"}`,
            origin: url,
        };
    } catch (e) {
        ctx.log.error(`handle pic from url ${url} fail: ${JSON.stringify(e)}`);
        return undefined;
    }
}

// 图片压缩
function compressPic(item) {
    return imagemin
        .buffer(item.buffer, {
            plugins: [
                imageminPngquant(),
                imageminJpegtran(),
                imageminGifsicle(),
            ],
        })
        .then((newBuffer) => {
            const { width, height } = imageSize(newBuffer);
            item.buffer = newBuffer;
            item.width = width;
            item.height = height;
            console.log(`Compress image ${item.fileName} success`);
            return item;
        });
}

// 获取图片大小
function getImageSize(buffer) {
    try {
        const size = sizeOf(buffer);
        return {
            real: true,
            width: size.width,
            height: size.height,
            type: size.type,
        };
    } catch (e) {
        return {
            real: false,
            width: 200,
            height: 200,
            type: ".png",
        };
    }
}

export { migrateNotionImageFromURL, batchMigrateNotionImages };
