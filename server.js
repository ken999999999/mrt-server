require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const MRT_USER = process.env.MRT_USER;
const MRT_PASS = process.env.MRT_PASS;

if (!MRT_USER || !MRT_PASS) {
  console.warn('⚠️ MRT_USER / MRT_PASS 尚未設定');
}

const TRACK_INFO_URL = 'https://api.metro.taipei/metroapi/TrackInfo.asmx';
const CAR_WEIGHT_EX_URL = 'https://api.metro.taipei/metroapi/CarWeight.asmx';
const CAR_WEIGHT_BR_URL = 'https://api.metro.taipei/metroapi/CarWeightBR.asmx';

// 快取物件
const cache = {
  lastUpdate: null,
  merged: [], // 這是我們要回傳給前端的唯一資料
  ok: false,
};

// ====== SOAP Helper Functions ======
function buildSoapBody(methodName) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <${methodName} xmlns="http://tempuri.org/">
      <userName>${MRT_USER}</userName>
      <passWord>${MRT_PASS}</passWord>
    </${methodName}>
  </soap12:Body>
</soap12:Envelope>`;
}

function extractJsonArrayFromSoap(raw) {
  if (typeof raw !== 'string') raw = String(raw);
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    // 嘗試修復常見的跳脫字元問題
    try {
        const unescaped = raw.slice(start, end + 1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        return JSON.parse(unescaped);
    } catch (e2) { return []; }
  }
}

// ====== Data Fetching ======
async function fetchApi(url, method) {
  try {
    const res = await axios.post(url, buildSoapBody(method), {
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      timeout: 10000,
    });
    return extractJsonArrayFromSoap(res.data);
  } catch (e) {
    console.error(`Fetch error ${method}:`, e.message);
    return [];
  }
}

// ====== Helper: 正規化站名 (移除 BR、空白、換行、"站"字尾) ======
function normalizeStation(name) {
  if (!name) return "";
  // 1. 轉字串 2. 移除 "BR" 前綴 3. 移除 "站" 字尾 4. 移除所有空白與換行(\n)
  return String(name)
    .replace(/^BR/i, '') 
    .replace(/站$/, '')
    .replace(/\s+/g, '');
}

async function updateAll() {
  if (!MRT_USER || !MRT_PASS) return;
  
  console.log('⏳ 更新資料中...');
  const [trackList, wEx, wBr] = await Promise.all([
    fetchApi(TRACK_INFO_URL, 'getTrackInfo'),
    fetchApi(CAR_WEIGHT_EX_URL, 'getCarWeightByInfoEx'),
    fetchApi(CAR_WEIGHT_BR_URL, 'getCarWeightBRInfo')
  ]);

  // 1. 建立高運量 (板南/淡水信義等) 的索引：使用 TrainNumber
  const weightMapById = new Map();
  wEx.forEach(w => {
    if (w.TrainNumber) {
      weightMapById.set(String(w.TrainNumber).trim(), w);
    }
  });

  // 2. 建立文湖線 (BR) 的索引：使用 "站名_方向"
  // 根據 PDF 與捷運邏輯：
  // 下行 (Down) -> 往 南港展覽館 (車站編號增加 BR01->BR24)
  // 上行 (Up)   -> 往 動物園 (車站編號減少 BR24->BR01)
  const wenhuMap = new Map(); 
  
  wBr.forEach(w => {
    const rawName = w.StationName || "";
    const cleanName = normalizeStation(rawName);
    const du = w.DU || ""; // "上行" 或 "下行"

    let dirKey = "";
    if (du.includes("下")) dirKey = "ToNangang"; // 下行往南港
    else if (du.includes("上")) dirKey = "ToZoo"; // 上行往動物園

    if (cleanName && dirKey) {
      // Key 範例: "大直_ToNangang"
      wenhuMap.set(`${cleanName}_${dirKey}`, w);
    }
  });

  // 3. 合併資料
  const mergedData = trackList.map(t => {
    const tNum = String(t.TrainNumber || '').trim();
    let wData = null;

    // 判斷是否為文湖線 (透過目的地或路線ID判斷)
    // 文湖線特徵：車號通常為空，且目的地是 動物園 或 南港展覽館
    const isWenhu = t.LineId === 'BR' || 
                    t.DestinationName.includes("動物園") || 
                    (t.DestinationName.includes("南港展覽館") && !tNum); // 南港展覽館板南線也有，但板南線有車號

    if (isWenhu) {
      // --- 文湖線配對邏輯 ---
      const cleanStation = normalizeStation(t.StationName);
      let dirKey = "";
      
      // 將 TrackInfo 的 DestinationName 轉為我們自定義的 key
      if (t.DestinationName.includes("南港")) dirKey = "ToNangang";
      else if (t.DestinationName.includes("動物園")) dirKey = "ToZoo";

      if (cleanStation && dirKey) {
        wData = wenhuMap.get(`${cleanStation}_${dirKey}`);
      }
    } else {
      // --- 高運量配對邏輯 (原本的) ---
      if (tNum) {
        wData = weightMapById.get(tNum);
      }
    }

    return {
      trainNumber: tNum,
      stationName: t.StationName,
      destinationName: t.DestinationName,
      countDown: t.CountDown,
      nowDateTime: t.NowDateTime,
      // 統一回傳結構，如果 wData 存在，前端就能讀到 Car1~Car4
      rawCrowd: wData 
    };
  });

  cache.merged = mergedData;
  cache.lastUpdate = new Date().toISOString();
  cache.ok = true;
  
  const matchedCount = mergedData.filter(d => d.rawCrowd).length;
  console.log(`✅ 更新完成: 總共 ${mergedData.length} 筆，含擁擠度資料: ${matchedCount} 筆`);
}
// ... (後面的 code 不變)
// 每 15 秒更新一次 (捷運 API 反應沒那麼快，太快會被擋)
setInterval(updateAll, 15000);
updateAll();

// ====== API Route ======
// 前端現在只需要呼叫這一支 API
app.get('/api/trains', (req, res) => {
  res.json({
    success: cache.ok,
    lastUpdate: cache.lastUpdate,
    count: cache.merged.length,
    data: cache.merged
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
