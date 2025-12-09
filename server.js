// server.js - 修復擁擠度消失問題 (加入文字正規化)

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
  console.warn('⚠️ MRT_USER / MRT_PASS 尚未設定，請在環境變數中設定。');
}

// Endpoints
const TRACK_INFO_URL = 'https://api.metro.taipei/metroapi/TrackInfo.asmx';
const CAR_WEIGHT_EX_URL = 'https://api.metro.taipei/metroapi/CarWeight.asmx';
const CAR_WEIGHT_BR_URL = 'https://api.metro.taipei/metroapi/CarWeightBR.asmx';

// ====== 完整車站對照表 (ID -> Name) ======
// 這裡用「台」，但 API 可能回傳「臺」，下面程式碼會自動處理
const stationMap = {
  // 文湖線
  'BR01': '動物園', 'BR02': '木柵', 'BR03': '萬芳社區', 'BR04': '萬芳醫院',
  'BR05': '辛亥', 'BR06': '麟光', 'BR07': '六張犁', 'BR08': '科技大樓',
  'BR09': '大安', 'BR10': '忠孝復興', 'BR11': '南京復興', 'BR12': '中山國中',
  'BR13': '松山機場', 'BR14': '大直', 'BR15': '劍南路', 'BR16': '西湖',
  'BR17': '港墘', 'BR18': '文德', 'BR19': '內湖', 'BR20': '大湖公園',
  'BR21': '葫洲', 'BR22': '東湖', 'BR23': '南港軟體園區', 'BR24': '南港展覽館',
  // 淡水信義線
  'R02': '象山', 'R03': '台北101/世貿', 'R04': '信義安和', 'R05': '大安',
  'R06': '大安森林公園', 'R07': '東門', 'R08': '中正紀念堂', 'R09': '台大醫院',
  'R10': '台北車站', 'R11': '中山', 'R12': '雙連', 'R13': '民權西路',
  'R14': '圓山', 'R15': '劍潭', 'R16': '士林', 'R17': '芝山',
  'R18': '明德', 'R19': '石牌', 'R20': '唭哩岸', 'R21': '奇岩',
  'R22': '北投', 'R22A': '新北投', 'R23': '復興崗', 'R24': '忠義',
  'R25': '關渡', 'R26': '竹圍', 'R27': '紅樹林', 'R28': '淡水',
  // 松山新店線
  'G01': '新店', 'G02': '新店區公所', 'G03': '七張', 'G03A': '小碧潭',
  'G04': '大坪林', 'G05': '景美', 'G06': '萬隆', 'G07': '公館',
  'G08': '台電大樓', 'G09': '古亭', 'G10': '中正紀念堂', 'G11': '小南門',
  'G12': '西門', 'G13': '北門', 'G14': '中山', 'G15': '松江南京',
  'G16': '南京復興', 'G17': '台北小巨蛋', 'G18': '南京三民', 'G19': '松山',
  // 中和新蘆線
  'O01': '南勢角', 'O02': '景安', 'O03': '永安市場', 'O04': '頂溪',
  'O05': '古亭', 'O06': '東門', 'O07': '忠孝新生', 'O08': '松江南京',
  'O09': '行天宮', 'O10': '中山國小', 'O11': '民權西路', 'O12': '大橋頭',
  'O13': '台北橋', 'O14': '菜寮', 'O15': '三重', 'O16': '先嗇宮',
  'O17': '頭前庄', 'O18': '新莊', 'O19': '輔大', 'O20': '丹鳳', 'O21': '迴龍',
  'O50': '三重國小', 'O51': '三和國中', 'O52': '徐匯中學', 'O53': '三民高中', 'O54': '蘆洲',
  // 板南線
  'BL01': '頂埔', 'BL02': '永寧', 'BL03': '土城', 'BL04': '海山',
  'BL05': '亞東醫院', 'BL06': '府中', 'BL07': '板橋', 'BL08': '新埔',
  'BL09': '江子翠', 'BL10': '龍山寺', 'BL11': '西門', 'BL12': '台北車站',
  'BL13': '善導寺', 'BL14': '忠孝新生', 'BL15': '忠孝復興', 'BL16': '忠孝敦化',
  'BL17': '國父紀念館', 'BL18': '市政府', 'BL19': '永春', 'BL20': '後山埤',
  'BL21': '昆陽', 'BL22': '南港', 'BL23': '南港展覽館',
  // 環狀線
  'Y07': '大坪林', 'Y08': '十四張', 'Y09': '秀朗橋', 'Y10': '景平',
  'Y11': '景安', 'Y12': '中和', 'Y13': '橋和', 'Y14': '中原',
  'Y15': '板新', 'Y16': '板橋', 'Y17': '新埔民生', 'Y18': '頭前庄',
  'Y19': '幸福', 'Y20': '新北產業園區'
};

const cache = {
  lastUpdate: null,
  trackInfo: [],
  carWeight: [],
  ok: false,
};

// ====== SOAP Builders (SOAP 1.2) ======
function buildSoap(methodName, bodyContent) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <${methodName} xmlns="http://tempuri.org/">
      ${bodyContent}
    </${methodName}>
  </soap12:Body>
</soap12:Envelope>`;
}

// ====== Helpers ======
function extractJsonArrayFromSoap(raw, tagName) {
  if (typeof raw !== 'string') raw = String(raw);
  if (raw.includes('<title>請洽系統管理員') || raw.includes('<html')) return [];
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  
  const jsonSlice = raw.slice(start, end + 1);
  try {
    return JSON.parse(jsonSlice);
  } catch (e) {
    try {
      const unescaped = jsonSlice.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      return JSON.parse(unescaped);
    } catch (e2) {
      return [];
    }
  }
}

// ====== API Calls ======
async function fetchTrackInfo() {
  const body = `<userName>${MRT_USER}</userName><passWord>${MRT_PASS}</passWord>`;
  const res = await axios.post(TRACK_INFO_URL, buildSoap('getTrackInfo', body), {
    headers: { 'Content-Type': 'text/xml; charset=utf-8' }, timeout: 10000
  });
  return extractJsonArrayFromSoap(res.data, 'TrackInfo');
}

async function fetchCarWeightAll() {
  const body = `<userName>${MRT_USER}</userName><passWord>${MRT_PASS}</passWord>`;
  const [exRes, brRes] = await Promise.all([
    axios.post(CAR_WEIGHT_EX_URL, buildSoap('getCarWeightByInfoEx', body), { headers: { 'Content-Type': 'text/xml; charset=utf-8' }, timeout: 10000 }),
    axios.post(CAR_WEIGHT_BR_URL, buildSoap('getCarWeightBRInfo', body), { headers: { 'Content-Type': 'text/xml; charset=utf-8' }, timeout: 10000 })
  ]);
  
  const exList = extractJsonArrayFromSoap(exRes.data, 'CarWeightEx');
  const brList = extractJsonArrayFromSoap(brRes.data, 'CarWeightBR');
  
  exList.forEach(row => { row.lineType = 'HighCapacity'; });
  brList.forEach(row => { row.lineType = 'Wenhu'; });
  
  return [...exList, ...brList];
}

// ====== Data Processing (修復重點：加入 normalize) ======
function trainsByStationId(stationId, trackList, weightList) {
  const sid = stationId.toUpperCase();
  const sName = stationMap[sid]; 

  const resultTrains = [];
  const processedTrainNumbers = new Set();

  // 🔥 小工具：統一轉成「台」，並去除空白
  const normalize = (str) => (str || '').replace(/臺/g, '台').trim();
  const normSName = normalize(sName);

  // 1. 處理 CarWeight (擁擠度資料)
  const weightMatches = (weightList || []).filter(row => {
    if (!row.StationID) return false;
    
    // API 回傳的 StationID 有可能是代號 (BR01) 也有可能是中文 (海山)
    // 甚至可能是 "臺北車站"
    const rowSid = normalize(String(row.StationID));
    
    // 比對：ID 相符 OR 中文站名相符
    return rowSid.toUpperCase() === sid || (normSName && rowSid === normSName);
  });

  weightMatches.forEach(w => {
    const num = w.TrainNumber ? String(w.TrainNumber).trim() : '';
    if (!num) return;

    // 嘗試在 TrackInfo 找對應的資料
    const t = (trackList || []).find(row => {
        return row.TrainNumber && String(row.TrainNumber).trim() === num;
    });

    resultTrains.push({
        trainNumber: num,
        stationId: sid,
        stationName: sName,
        destinationName: t?.DestinationName || null,
        countDown: t?.CountDown || null,
        nowDateTime: t?.NowDateTime || null, 
        rawTrack: t || null,
        rawCrowd: w
    });
    processedTrainNumbers.add(num);
  });

  // 2. 處理 TrackInfo (補漏：沒擁擠度但有在跑馬燈的車)
  if (sName) {
      const trackMatches = (trackList || []).filter(row => {
          // TrackInfo 通常給中文，一樣要 normalize
          const rawName = normalize(row.StationName);
          return rawName.includes(normSName); 
      });

      trackMatches.forEach(t => {
          const num = t.TrainNumber ? String(t.TrainNumber).trim() : '';
          
          if (num && processedTrainNumbers.has(num)) return;

          resultTrains.push({
              trainNumber: num || 'Unknown',
              stationId: sid,
              stationName: sName,
              destinationName: t.DestinationName,
              countDown: t.CountDown,
              nowDateTime: t.NowDateTime,
              rawTrack: t,
              rawCrowd: null 
          });
      });
  }

  return resultTrains;
}

async function updateAll() {
  if (!MRT_USER || !MRT_PASS) return;
  try {
    const [trackList, weightAll] = await Promise.all([fetchTrackInfo(), fetchCarWeightAll()]);
    cache.lastUpdate = new Date().toISOString();
    cache.trackInfo = trackList;
    cache.carWeight = weightAll;
    cache.ok = true;
    console.log(`Update: Track=${trackList.length}, Weight=${weightAll.length}`);
  } catch (e) {
    console.error('Update failed:', e.message);
    cache.ok = false;
  }
}

// Init
updateAll();
setInterval(updateAll, 30000);

// ====== Routes ======

app.get('/', (req, res) => res.json({ status: 'ok', lastUpdate: cache.lastUpdate }));

app.get('/api/trains', (req, res) => {
    res.json({ success: cache.ok, data: cache.carWeight }); 
});

app.get('/api/station/:stationId', (req, res) => {
    const stationId = req.params.stationId.toUpperCase();
    const trains = trainsByStationId(stationId, cache.trackInfo, cache.carWeight);
    
    res.json({
        success: cache.ok,
        stationId,
        lastUpdate: cache.lastUpdate,
        count: trains.length,
        trains: trains
    });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
