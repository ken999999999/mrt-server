require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// 在 Render / 本機 .env 設定：MRT_USER / MRT_PASS
const MRT_USER = process.env.MRT_USER;
const MRT_PASS = process.env.MRT_PASS;

if (!MRT_USER || !MRT_PASS) {
  console.warn('⚠️ MRT_USER / MRT_PASS 尚未設定，請在環境變數中設定捷運提供的帳號密碼。');
}

// TRTC endpoints
const TRACK_INFO_URL = 'https://api.metro.taipei/metroapi/TrackInfo.asmx';
const CAR_WEIGHT_EX_URL = 'https://api.metro.taipei/metroapi/CarWeight.asmx';      // getCarWeightByInfoEx（全部高運量線，不含文湖）
const CAR_WEIGHT_BR_URL = 'https://api.metro.taipei/metroapi/CarWeightBR.asmx';   // getCarWeightBRInfo（文湖線）

// 簡單的全域快取
const cache = {
  lastUpdate: null,
  trackInfo: [],
  carWeight: [],  // Ex + BR 合併後的全部擁擠度
  merged: [],
  ok: false,
};

// ====== SOAP body ======
function buildTrackInfoSoap() {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <getTrackInfo xmlns="http://tempuri.org/">
      <userName>${MRT_USER}</userName>
      <passWord>${MRT_PASS}</passWord>
    </getTrackInfo>
  </soap12:Body>
</soap12:Envelope>`;
}

// 高運量（板南、淡水信義、中和新蘆、松山新店…）擁擠度
function buildCarWeightExSoap() {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <getCarWeightByInfoEx xmlns="http://tempuri.org/">
      <userName>${MRT_USER}</userName>
      <passWord>${MRT_PASS}</passWord>
    </getCarWeightByInfoEx>
  </soap12:Body>
</soap12:Envelope>`;
}

// 文湖線擁擠度
function buildCarWeightBRSoap() {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <getCarWeightBRInfo xmlns="http://tempuri.org/">
      <userName>${MRT_USER}</userName>
      <passWord>${MRT_PASS}</passWord>
    </getCarWeightBRInfo>
  </soap12:Body>
</soap12:Envelope>`;
}

// ====== 共用：從 SOAP 字串裡抓 JSON 陣列 ======
function extractJsonArrayFromSoap(raw, tagName) {
  if (typeof raw !== 'string') {
    raw = String(raw);
  }

  // 粗略檢查有沒有錯誤頁
  if (raw.includes('<title>請洽系統管理員') || raw.includes('<html')) {
    console.error(`❌ ${tagName} 收到 HTML 錯誤頁，無法解析 JSON。`);
    return [];
  }

  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');

  if (start === -1 || end === -1 || end <= start) {
    // 有時候回傳空陣列或者是沒資料，這裡不一定是錯，但如果是 HTML 格式就會在上面被擋掉
    // console.error(`❌ ${tagName} 找不到 JSON 陣列 [ ... ]`); 
    return [];
  }

  const jsonSlice = raw.slice(start, end + 1);

  const normalizeParsed = (parsed) => {
    if (typeof parsed === 'string') {
      return JSON.parse(parsed);
    }
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return [];
  };

  try {
    const parsed = JSON.parse(jsonSlice);
    return normalizeParsed(parsed);
  } catch (e1) {
    try {
      const unescaped = jsonSlice
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      const parsed2 = JSON.parse(unescaped);
      return normalizeParsed(parsed2);
    } catch (e2) {
      console.error(`❌ ${tagName} 解析 JSON 失敗:`, e2.message);
      return [];
    }
  }
}

// ====== 呼叫 TRTC 3 支 API ======
async function fetchTrackInfo() {
  const soapBody = buildTrackInfoSoap();
  const res = await axios.post(TRACK_INFO_URL, soapBody, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    timeout: 10000,
  });
  return extractJsonArrayFromSoap(res.data, 'TrackInfo');
}

async function fetchCarWeightEx() {
  const soapBody = buildCarWeightExSoap();
  const res = await axios.post(CAR_WEIGHT_EX_URL, soapBody, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    timeout: 10000,
  });
  return extractJsonArrayFromSoap(res.data, 'CarWeightEx');
}

async function fetchCarWeightBR() {
  const soapBody = buildCarWeightBRSoap();
  const res = await axios.post(CAR_WEIGHT_BR_URL, soapBody, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    timeout: 10000,
  });
  return extractJsonArrayFromSoap(res.data, 'CarWeightBR');
}

async function fetchCarWeightAll() {
  const [exList, brList] = await Promise.all([
    fetchCarWeightEx(),
    fetchCarWeightBR(),
  ]);

  exList.forEach(row => { row.lineType = 'HighCapacity'; }); 
  brList.forEach(row => { row.lineType = 'Wenhu'; });

  return [...exList, ...brList];
}

// 將 TrackInfo + CarWeight 合併（用 TrainNumber 當 key）
function mergeTrackAndWeight(trackList, weightList) {
  const weightByTrain = new Map();
  (weightList || []).forEach(row => {
    const num = row.TrainNumber != null ? String(row.TrainNumber).trim() : '';
    if (!num) return;
    weightByTrain.set(num, row);
  });

  return (trackList || []).map(row => {
    const num = row.TrainNumber != null ? String(row.TrainNumber).trim() : '';
    const w = weightByTrain.get(num) || null;
    return {
      trainNumber: num,
      stationName: row.StationName || null,
      destinationName: row.DestinationName || null,
      countDown: row.CountDown || null,
      nowDateTime: row.NowDateTime || null,
      rawTrack: row,
      rawCrowd: w,
    };
  });
}

// ====== 完整的站碼對中文站名對照表 (對應 App 的 STATIONS_DB) ======
const stationIdToName = {
  // 文湖線 (BR)
  BR01: "動物園", BR02: "木柵", BR03: "萬芳社區", BR04: "萬芳醫院",
  BR05: "辛亥", BR06: "麟光", BR07: "六張犁", BR08: "科技大樓",
  BR09: "大安", BR10: "忠孝復興", BR11: "南京復興", BR12: "中山國中",
  BR13: "松山機場", BR14: "大直", BR15: "劍南路", BR16: "西湖",
  BR17: "港墘", BR18: "文德", BR19: "內湖", BR20: "大湖公園",
  BR21: "葫洲", BR22: "東湖", BR23: "南港軟體園區", BR24: "南港展覽館",

  // 淡水信義線 (R)
  R02: "象山", R03: "台北101/世貿", R04: "信義安和", R05: "大安",
  R06: "大安森林公園", R07: "東門", R08: "中正紀念堂", R09: "台大醫院",
  R10: "台北車站", R11: "中山", R12: "雙連", R13: "民權西路",
  R14: "圓山", R15: "劍潭", R16: "士林", R17: "芝山",
  R18: "明德", R19: "石牌", R20: "唭哩岸", R21: "奇岩",
  R22: "北投", R22A: "新北投", R23: "復興崗", R24: "忠義",
  R25: "關渡", R26: "竹圍", R27: "紅樹林", R28: "淡水",

  // 松山新店線 (G)
  G01: "新店", G02: "新店區公所", G03: "七張", G03A: "小碧潭",
  G04: "大坪林", G05: "景美", G06: "萬隆", G07: "公館",
  G08: "台電大樓", G09: "古亭", G10: "中正紀念堂", G11: "小南門",
  G12: "西門", G13: "北門", G14: "中山", G15: "松江南京",
  G16: "南京復興", G17: "台北小巨蛋", G18: "南京三民", G19: "松山",

  // 中和新蘆線 (O)
  O01: "南勢角", O02: "景安", O03: "永安市場", O04: "頂溪",
  O05: "古亭", O06: "東門", O07: "忠孝新生", O08: "松江南京",
  O09: "行天宮", O10: "中山國小", O11: "民權西路", O12: "大橋頭",
  O13: "台北橋", O14: "菜寮", O15: "三重", O16: "先嗇宮",
  O17: "頭前庄", O18: "新莊", O19: "輔大", O20: "丹鳳", O21: "迴龍",
  O50: "三重國小", O51: "三和國中", O52: "徐匯中學", O53: "三民高中", O54: "蘆洲",

  // 板南線 (BL)
  BL01: "頂埔", BL02: "永寧", BL03: "土城", BL04: "海山",
  BL05: "亞東醫院", BL06: "府中", BL07: "板橋", BL08: "新埔",
  BL09: "江子翠", BL10: "龍山寺", BL11: "西門", BL12: "台北車站",
  BL13: "善導寺", BL14: "忠孝新生", BL15: "忠孝復興", BL16: "忠孝敦化",
  BL17: "國父紀念館", BL18: "市政府", BL19: "永春", BL20: "後山埤",
  BL21: "昆陽", BL22: "南港", BL23: "南港展覽館",

  // 環狀線 (Y)
  Y07: "大坪林", Y08: "十四張", Y09: "秀朗橋", Y10: "景平",
  Y11: "景安", Y12: "中和", Y13: "橋和", Y14: "中原",
  Y15: "板新", Y16: "板橋", Y17: "新埔民生", Y18: "頭前庄",
  Y19: "幸福", Y20: "新北產業園區"
};

// ====== 修改後的 trainsByStationId (優先查詢 TrackInfo) ======
function trainsByStationId(stationId, trackList, weightList) {
  const sid = stationId.toUpperCase();
  const sName = stationIdToName[sid]; // 取得中文站名，例如 "忠孝新生"

  // 1. 先找出所有在這個車站的列車 (從 TrackInfo 找，因為這裡有倒數時間)
  let targetTrains = [];
  if (sName) {
    targetTrains = (trackList || []).filter(t => t.StationName === sName);
  }

  // 2. 找出該站的擁擠度資料 (作為備用或合併用)
  const stationWeightData = (weightList || []).filter(w => w.StationID === sid);

  // 3. 建立一個 Map 方便快速查找擁擠度 (Key: TrainNumber)
  const weightMap = new Map();
  stationWeightData.forEach(w => {
    const num = w.TrainNumber != null ? String(w.TrainNumber).trim() : '';
    if (num) weightMap.set(num, w);
  });

  // 4. 合併資料
  // 情況 A: TrackInfo 有資料的列車 (這是主要的)
  const mergedResults = targetTrains.map(track => {
    const num = track.TrainNumber != null ? String(track.TrainNumber).trim() : '';
    
    // 嘗試從該站的擁擠度資料找
    let w = weightMap.get(num);
    
    // 如果該站沒擁擠度，嘗試從全域擁擠度找 (有時候車子剛離站，擁擠度還在但站點判定稍微不同)
    if (!w) {
       w = (weightList || []).find(row => String(row.TrainNumber).trim() === num);
    }

    return {
      trainNumber: num,
      stationId: sid,
      stationName: track.StationName,
      destinationName: track.DestinationName,
      countDown: track.CountDown,
      nowDateTime: track.NowDateTime,
      rawTrack: track,
      rawCrowd: w || null
    };
  });

  // 情況 B: 只有擁擠度資料，但 TrackInfo 沒資料的列車 (補漏)
  stationWeightData.forEach(w => {
    const num = w.TrainNumber != null ? String(w.TrainNumber).trim() : '';
    // 如果這班車還不在結果清單中，就加進去
    const exists = mergedResults.find(r => r.trainNumber === num);
    if (!exists) {
        const t = (trackList || []).find(row => String(row.TrainNumber).trim() === num);
        mergedResults.push({
            trainNumber: num,
            stationId: sid,
            stationName: sName || w.StationName,
            destinationName: t?.DestinationName || null,
            countDown: t?.CountDown || null,
            nowDateTime: t?.NowDateTime || null,
            rawTrack: t || null,
            rawCrowd: w
        });
    }
  });

  return mergedResults;
}

// ====== 定期更新快取 ======
async function updateAll() {
  if (!MRT_USER || !MRT_PASS) {
    console.error('❌ MRT_USER / MRT_PASS 尚未設定，無法呼叫 TRTC API');
    cache.ok = false;
    return;
  }

  try {
    console.log('⏳ 正在更新 TrackInfo / CarWeightEx / CarWeightBR …');

    const [trackList, weightAll] = await Promise.all([
      fetchTrackInfo(),
      fetchCarWeightAll(),
    ]);

    cache.lastUpdate = new Date().toISOString();
    cache.trackInfo = trackList;
    cache.carWeight = weightAll;
    cache.merged = mergeTrackAndWeight(trackList, weightAll);
    cache.ok = true;

    console.log(
      `✅ 更新完成：TrackInfo=${trackList.length} 筆, CarWeightAll=${weightAll.length} 筆, merged=${cache.merged.length} 筆`
    );
  } catch (e) {
    console.error('❌ 更新資料失敗:', e.message);
    cache.ok = false;
  }
}

// 啟動時先更新一次，之後每 30 秒更新
updateAll();
setInterval(updateAll, 30000);

// ====== Routes ======
app.get('/', (req, res) => {
  res.json({
    ok: cache.ok,
    message: 'TRTC API proxy running',
    lastUpdate: cache.lastUpdate,
    counts: {
      trackInfo: cache.trackInfo.length,
      carWeight: cache.carWeight.length,
      merged: cache.merged.length,
    },
  });
});

app.get('/api/raw/track-info', (req, res) => {
  res.json({
    success: cache.ok,
    lastUpdate: cache.lastUpdate,
    count: cache.trackInfo.length,
    items: cache.trackInfo,
  });
});

app.get('/api/raw/car-weight', (req, res) => {
  res.json({
    success: cache.ok,
    lastUpdate: cache.lastUpdate,
    count: cache.carWeight.length,
    items: cache.carWeight,
  });
});

app.get('/api/station/:stationId', (req, res) => {
  const stationId = req.params.stationId.toUpperCase();
  const stationName = stationIdToName[stationId] || stationId;

  const trains = trainsByStationId(
    stationId,
    cache.trackInfo,
    cache.carWeight
  );

  res.json({
    success: cache.ok,
    stationId,
    stationName,
    lastUpdate: cache.lastUpdate,
    count: trains.length,
    trains,
    note: '已修正為優先查詢 TrackInfo，即使沒有擁擠度也會顯示列車',
  });
});

app.get('/api/trains', (req, res) => {
  res.json({
    success: cache.ok,
    lastUpdate: cache.lastUpdate,
    count: cache.merged.length,
    data: cache.merged,
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
