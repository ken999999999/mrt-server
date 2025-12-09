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

async function updateAll() {
  if (!MRT_USER || !MRT_PASS) return;
  
  console.log('⏳ 更新資料中...');
  const [trackList, wEx, wBr] = await Promise.all([
    fetchApi(TRACK_INFO_URL, 'getTrackInfo'),
    fetchApi(CAR_WEIGHT_EX_URL, 'getCarWeightByInfoEx'),
    fetchApi(CAR_WEIGHT_BR_URL, 'getCarWeightBRInfo')
  ]);

  // 合併高運量與文湖線的擁擠度資料
  const weightList = [...wEx, ...wBr];

  // 建立 Map 加速查找 (Key: TrainNumber)
  const weightMap = new Map();
  weightList.forEach(w => {
    if (w.TrainNumber) weightMap.set(String(w.TrainNumber).trim(), w);
  });

  // 將擁擠度塞入列車位置資訊中 (以 TrackInfo 為主體)
  // 如果只有擁擠度但沒有位置(TrackInfo)，這裡選擇不回傳(因為不知道它在哪)，或者前端需要另外處理
  // 這裡邏輯改為：以 TrackInfo 為主，有對應車號就補上擁擠度
  const mergedData = trackList.map(t => {
    const tNum = String(t.TrainNumber).trim();
    const wData = weightMap.get(tNum) || null;
    return {
      trainNumber: tNum,
      stationName: t.StationName,       // 前端用這個來過濾
      destinationName: t.DestinationName,
      countDown: t.CountDown,
      nowDateTime: t.NowDateTime,       // 這是伺服器時間，前端用這個校正
      rawCrowd: wData                   // 擁擠度原始資料
    };
  });

  cache.merged = mergedData;
  cache.lastUpdate = new Date().toISOString();
  cache.ok = true;
  console.log(`✅ 更新完成: ${mergedData.length} 筆列車資料`);
}

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
