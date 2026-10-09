/**
 * export.js — 导出台账为 Excel（.xlsx）
 *
 * 为什么前端生成而不是后端：数据已经在内存里，SheetJS 在浏览器端就能出 xlsx，
 * 不依赖服务端算力，也不用来回传文件。
 *
 * 保存位置：
 * - Tauri 桌面端：弹系统"另存为"对话框让用户选（默认文件名带日期范围），
 *   再用 fs 插件写盘。
 * - 纯浏览器（vite dev 调试）：退回 Blob + <a download> 触发浏览器下载。
 */

import * as XLSX from 'xlsx';

/** 冻结首行 + 列宽 */
const FREEZE = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };

function applyMeta(ws, widths) {
  if (Array.isArray(widths) && widths.length) {
    ws['!cols'] = widths.map(w => ({ wch: w }));
  }
  ws['!freeze'] = { ...FREEZE };
  return ws;
}

/** 把 [{表头: 值}] 转成 worksheet，并按给定列宽设置 */
function sheetFromRows(rows, widths) {
  return applyMeta(XLSX.utils.json_to_sheet(rows), widths);
}

/** 有列定义但无数据 → 只输出表头的空表（比「无数据」占位更可读） */
function emptySheetFromHeaders(headers, widths) {
  return applyMeta(XLSX.utils.json_to_sheet([], { header: headers }), widths);
}

function isTauri() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

/**
 * 导出并保存。
 * @param {string} filename 建议文件名（含 .xlsx）
 * @param {Array<{name:string, rows:Array<object>, widths?:number[], headers?:string[]}>} sheets 工作表定义
 *   headers：列顺序。无数据时用它输出空表头；不传则退回「无数据」占位行。
 * @returns {Promise<string|null>} 保存的完整路径；浏览器下载时返回 null
 */
export async function exportXlsx(filename, sheets) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    let ws;
    if (s.rows && s.rows.length) {
      ws = sheetFromRows(s.rows, s.widths);
    } else if (Array.isArray(s.headers) && s.headers.length) {
      ws = emptySheetFromHeaders(s.headers, s.widths);
    } else {
      ws = sheetFromRows([{ 提示: '无数据' }], s.widths);
    }
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const bytes = new Uint8Array(buf);

  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({
      defaultPath: filename,
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
    });
    if (!path) return null;               // 用户取消
    await writeFile(path, bytes);
    return path;
  }

  // 浏览器兜底
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return null;
}
