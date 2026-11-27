/**
 * The number settings of an account's cloud space (object storage), shared by the management panel's Storage page and
 * the account settings in the room website. Ranges follow `.dev/plans/附件对象存储/README.md`; the site checks them too.
 */
import { t } from "./i18n.js";

/**
 * The fields to show, in order.
 *
 * Args:
 *   attachment_limit_mib: the attachment limit, the most the threshold can be (a file over it cannot be a plain attachment).
 * Returns:
 *   [{ key, label, help, min, max, fallback, invalid }], `fallback` being the value shown when the site sends none.
 */
export function object_storage_fields(attachment_limit_mib = 50) {
  const limit = Math.max(1, Number(attachment_limit_mib) || 50);
  return [
    { key: "retention_days", label: t("保留天数"), min: 0, max: 30, fallback: 0,
      help: t("上传后满这么多天自动删除；填 0 表示不自动删除。需要自动清理时填 1 到 30。"),
      invalid: t("保留天数须为 0 到 30 的整数") },
    { key: "quota_mib", label: t("空间上限（MiB）"), min: 1, max: 1048576, fallback: 10240,
      help: t("本账号云空间最多存放的总大小，默认 10240（10 GiB）；用满后新的大文件上传会被拒绝，需要先删除旧文件。"),
      invalid: t("空间上限须为 1 到 1048576 的整数") },
    { key: "object_threshold_mib", label: t("走云空间的门槛（MiB）"), min: 1, max: limit, fallback: Math.min(20, limit),
      help: t("大于这个大小的附件存入云空间，其余仍作普通附件保存在电脑上；最大为单个附件上限 {limit} MiB。", { limit }),
      invalid: t("门槛须为 1 到 {limit} 的整数", { limit }) },
  ];
}

/**
 * Delete the chosen cloud space files one by one, as the site takes one ID per request, and add up what went.
 *
 * Args:
 *   ids: attachment IDs. remove: async (id) => { cleared: [...], freed_bytes }, one deletion.
 * Returns:
 *   { cleared, freed_bytes } over all; a failure stops there after the files already deleted are counted.
 */
export async function delete_cloud_files(ids, remove) {
  const total = { cleared: [], freed_bytes: 0 };
  for (const id of ids) {
    try {
      const result = await remove(id);
      total.cleared.push(...(result.cleared || []));
      total.freed_bytes += Number(result.freed_bytes) || 0;
    } catch (failure) {
      if (!total.cleared.length) throw failure;
      // What was deleted stays shown as deleted; the rest is reported.
      return { ...total, error: failure.message };
    }
  }
  return total;
}

/** The values to edit for `fields`, read from a settings answer of the site. */
export function object_storage_values(fields, settings) {
  return Object.fromEntries(fields.map(field => [field.key, Number.isInteger(settings?.[field.key]) ? settings[field.key] : field.fallback]));
}
