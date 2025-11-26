import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MapPin, Navigation as NavigationIcon, Clock, Users, RefreshCw, AlertCircle, Sparkles, Utensils, Lightbulb, Server, WifiOff, AlertTriangle, TrainFront, Activity, Terminal, ShieldCheck, XCircle, Eye, CalendarClock } from 'lucide-react';
import { GoogleGenerativeAI } from "@google/generative-ai";

// ⚠️ Render 網址
const RENDER_API_URL = 'https://my-tdx-api.onrender.com'; 
const REFRESH_INTERVAL = 20;

const LINE_CONFIG = {
  'BL': { name: '板南線', color: 'bg-blue-600', text: 'text-blue-600', badge: 'bg-blue-100 text-blue-700' },
  'R':  { name: '淡水信義線', color: 'bg-red-600', text: 'text-red-600', badge: 'bg-red-100 text-red-700' },
  'G':  { name: '松山新店線', color: 'bg-green-600', text: 'text-green-600', badge: 'bg-green-100 text-green-700' },
  'O':  { name: '中和新蘆線', color: 'bg-orange-500', text: 'text-orange-500', badge: 'bg-orange-100 text-orange-700' },
  'BR': { name: '文湖線', color: 'bg-yellow-600', text: 'text-yellow-600', badge: 'bg-yellow-100 text-yellow-800' },
  'Y':  { name: '環狀線', color: 'bg-yellow-400', text: 'text-yellow-500', badge: 'bg-yellow-100 text-yellow-800' },
  'Unknown': { name: '未知', color: 'bg-gray-400', text: 'text-gray-500', badge: 'bg-gray-100 text-gray-600' }
};

const deg2rad = (deg) => deg * (Math.PI / 180);
const getDistanceFromLatLonInKm = (lat1, lon1, lat2, lon2) => {
  const R = 6371; 
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(deg2rad(lat1))*Math.cos(deg2rad(lat2)) * Math.sin(dLon/2)*Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; 
};
const normalizeName = (name) => name ? name.replace(/臺/g, '台') : "";
const getRandomCrowdLevel = () => ['LOW','LOW','MEDIUM','HIGH'][Math.floor(Math.random()*4)];

const fetchGeminiRecommendation = async (stationName, type) => {
  try {
    const apiKey = ""; 
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-09-2025" });
    const prompt = type === 'food' ? `台北捷運「${stationName}」站附近3家必吃美食。` : `台北捷運「${stationName}」站的冷知識。`;
    const result = await model.generateContent(prompt);
    return (await result.response).text();
  } catch (error) { return "AI 忙線中..."; }
};

const STATIONS_DB = [
  { id: 'BL11', name: '西門', line: 'Blue', lat: 25.0421, lon: 121.5082 },
  { id: 'BL12', name: '台北車站', line: 'Blue', lat: 25.0461, lon: 121.5174 },
  { id: 'R10', name: '台北車站', line: 'Red', lat: 25.0461, lon: 121.5174 },
  { id: 'G12', name: '西門', line: 'Green', lat: 25.0421, lon: 121.5082 },
  { id: 'BR10', name: '忠孝復興', line: 'Brown', lat: 25.0415, lon: 121.5433 },
  { id: 'O05', name: '古亭', line: 'Orange', lat: 25.0263, lon: 121.5229 },
  { id: 'Y16', name: '板橋', line: 'Yellow', lat: 25.0137, lon: 121.4623 },
  // 建議自行擴充更多車站
];

const TrainCard = ({ destination, time, lineNo, stationName, type }) => {
  const isArriving = time === 0;
  const lineInfo = LINE_CONFIG[lineNo] || LINE_CONFIG['Unknown'];
  const isSchedule = type === 'schedule';

  return (
    <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex items-center justify-between mb-3">
      <div className="flex items-center gap-4">
        <div className={`flex flex-col items-center justify-center w-14 h-14 rounded-full ${isArriving ? 'bg-red-50 text-red-600 animate-pulse' : isSchedule ? 'bg-gray-100 text-gray-500' : 'bg-blue-50 text-blue-600'}`}>
          <span className="text-xl font-bold">{isArriving ? '進站' : time}</span>
          {!isArriving && <span className="text-[10px] font-medium">分</span>}
        </div>
        <div className="flex flex-col items-start">
          <div className="flex gap-2 mb-1">
             <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${lineInfo.badge}`}>{lineInfo.name}</span>
             {stationName && <span className="text-[10px] text-gray-500 bg-gray-100 px-2 py-0.5 rounded">{stationName}</span>}
             {isSchedule && <span className="text-[10px] text-gray-400 flex items-center gap-1"><CalendarClock className="w-3 h-3"/>表定</span>}
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-xs text-gray-400">往</span>
            <span className="text-lg font-bold text-gray-800 tracking-wide">{destination}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default function App() {
  const [location, setLocation] = useState(null);
  const [nearestStation, setNearestStation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [trains, setTrains] = useState([]);
  const [allRawTrains, setAllRawTrains] = useState([]); 
  const [serverStatus, setServerStatus] = useState('connecting'); 
  const [isFetching, setIsFetching] = useState(false);
  const [showAllMode, setShowAllMode] = useState(false);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [aiContent, setAiContent] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);

  // AI Function
  const handleAiRequest = async (type) => {
    if (aiLoading || !nearestStation) return;
    setAiLoading(true);
    setAiContent(null);
    const res = await fetchGeminiRecommendation(nearestStation.name, type);
    setAiContent(res);
    setAiLoading(false);
  };

  const fetchServerData = useCallback(async (stationName) => {
    if (!RENDER_API_URL) return;
    setIsFetching(true);
    setServerStatus('connecting');
    try {
      const res = await fetch(`${RENDER_API_URL}/api/trains`);
      const jsonData = await res.json();
      if (jsonData.success && Array.isArray(jsonData.data)) {
        if (jsonData.data.length === 0) {
           setServerStatus('warming_up'); setTrains([]); setAllRawTrains([]); return;
        }
        const raw = jsonData.data.map(t => ({ ...t, crowdLevel: getRandomCrowdLevel() }));
        setAllRawTrains(raw);
        const target = normalizeName(stationName);
        const filtered = raw.filter(t => normalizeName(t.stationName) === target);
        filtered.sort((a, b) => a.time - b.time || a.lineNo.localeCompare(b.lineNo));
        setTrains(filtered);
        setLastUpdated(new Date(jsonData.updatedAt || new Date()));
        setServerStatus('ok'); setError(null); setCountdown(REFRESH_INTERVAL);
      }
    } catch (err) {
      setTrains([]); setAllRawTrains([]); setServerStatus('error'); setError(err.message);
    } finally { setIsFetching(false); }
  }, []);

  const getUserLocation = useCallback(() => {
    setLoading(true); setError(null);
    if (!navigator.geolocation) { setLoading(false); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude }); setLoading(false); },
      (err) => { setLoading(false); }, { timeout: 10000 }
    );
  }, []);

  useEffect(() => {
    if (!nearestStation || isFetching) return;
    const timer = setInterval(() => setCountdown(p => p <= 1 ? (fetchServerData(nearestStation.name), REFRESH_INTERVAL) : p - 1), 1000);
    return () => clearInterval(timer);
  }, [nearestStation, isFetching, fetchServerData]);

  useEffect(() => { getUserLocation(); }, [getUserLocation]);

  useEffect(() => {
    if (location) {
      let min = Infinity; let closest = null;
      STATIONS_DB.forEach(s => {
        const d = getDistanceFromLatLonInKm(location.lat, location.lon, s.lat, s.lon);
        if (d < min) { min = d; closest = { ...s, distance: d }; }
      });
      if (closest && closest.distance < 10) { setNearestStation(closest); setAiContent(null); }
      else if (closest) { setNearestStation(null); setError("距離車站太遠"); }
    }
  }, [location]);

  useEffect(() => { if (nearestStation) { setShowAllMode(false); fetchServerData(nearestStation.name); } }, [nearestStation, fetchServerData]);

  const displayTrains = showAllMode ? allRawTrains : trains;

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-900 pb-20">
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-gray-200 px-4 py-3 shadow-sm relative">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <div className="bg-blue-600 p-1.5 rounded-lg"><TrainFront className="w-5 h-5 text-white" /></div>
            <h1 className="text-lg font-bold">捷運 Go</h1>
          </div>
          <div className="flex items-center gap-2">
            {!isFetching && nearestStation && <span className="text-xs font-mono text-gray-400 w-6 text-right">{countdown}s</span>}
            <button onClick={() => { if(nearestStation) fetchServerData(nearestStation.name); else getUserLocation(); }} disabled={isFetching} className={`p-2 rounded-full hover:bg-gray-100 ${isFetching ? 'animate-spin' : ''}`}>
              <RefreshCw className="w-5 h-5 text-gray-600" />
            </button>
          </div>
        </div>
        {!isFetching && nearestStation && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-gray-100"><div className="h-full bg-blue-500 transition-all duration-1000 ease-linear" style={{ width: `${(countdown / REFRESH_INTERVAL) * 100}%` }}></div></div>}
      </header>

      <main className="px-4 py-6 max-w-md mx-auto">
        <div className="flex justify-end mb-4">
           <div className="flex items-center gap-2">
             <span className={`w-2 h-2 rounded-full ${serverStatus === 'ok' ? 'bg-green-500' : 'bg-red-500'}`}></span>
             <span className="text-xs text-gray-500">{serverStatus === 'ok' ? '連線正常' : '連線異常'}</span>
           </div>
        </div>

        {error && <div className="mb-4 bg-red-50 text-red-800 px-4 py-3 rounded-xl text-sm flex items-center gap-2 border border-red-200"><AlertCircle className="w-4 h-4"/>{error}</div>}

        {loading ? (
          <div className="text-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>定位中...</div>
        ) : nearestStation ? (
          <>
            <div className="mb-6 bg-white rounded-3xl p-6 shadow-sm border border-gray-100 relative overflow-hidden">
               <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500 opacity-10 rounded-full blur-3xl transform translate-x-10 -translate-y-10"></div>
               <h1 className="text-3xl font-black text-gray-900">{nearestStation.name}</h1>
               <div className="mt-4 flex items-center text-xs text-gray-400 gap-1"><MapPin className="w-3 h-3"/> 距離 {nearestStation.distance < 1 ? Math.round(nearestStation.distance * 1000) + 'm' : nearestStation.distance.toFixed(1) + 'km'}</div>
            </div>

            <div className="space-y-3">
              <div className="flex justify-between items-center mb-2">
                <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">{showAllMode ? `全線列車 (${allRawTrains.length})` : '即時進站資訊'}</h2>
                {!showAllMode && trains.length === 0 && allRawTrains.length > 0 && (
                    <button onClick={() => setShowAllMode(true)} className="text-xs flex items-center gap-1 text-blue-600 bg-blue-50 px-2 py-1 rounded hover:bg-blue-100"><Eye className="w-3 h-3"/> 顯示全線</button>
                )}
                {showAllMode && <button onClick={() => setShowAllMode(false)} className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded hover:bg-gray-200">返回本站</button>}
              </div>

              {serverStatus === 'warming_up' ? <div className="text-center py-8 bg-orange-50 text-orange-600 text-xs rounded-2xl">伺服器暖機中...</div> :
               displayTrains.length > 0 ? displayTrains.map((t, i) => <TrainCard key={i} {...t} stationName={showAllMode ? t.stationName : null} />) :
               <div className="text-center py-8 bg-white rounded-2xl border border-gray-100 border-dashed text-gray-400 text-sm">暫無列車資訊</div>}
            </div>

            <div className="mt-8 mb-6 animate-slide-up">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1 mb-3"><Sparkles className="w-4 h-4 text-indigo-500" /> AI 智慧嚮導</h2>
              <div className="flex gap-3 mb-4">
                <button onClick={() => handleAiRequest('food')} className="flex-1 py-3 px-4 rounded-xl flex items-center justify-center gap-2 bg-white text-gray-600 border border-gray-100 hover:bg-gray-50 text-sm shadow-sm active:scale-95"><Utensils className="w-4 h-4"/> 附近美食</button>
                <button onClick={() => handleAiRequest('trivia')} className="flex-1 py-3 px-4 rounded-xl flex items-center justify-center gap-2 bg-white text-gray-600 border border-gray-100 hover:bg-gray-50 text-sm shadow-sm active:scale-95"><Lightbulb className="w-4 h-4"/> 車站冷知識</button>
              </div>
              {(aiLoading || aiContent) && (
                <div className="bg-white rounded-2xl p-5 shadow-sm border border-indigo-100 relative">
                  {aiLoading ? <p className="text-xs text-indigo-400 animate-pulse text-center">AI 思考中...</p> : <p className="prose prose-sm text-gray-700 text-sm whitespace-pre-line">{aiContent}</p>}
                </div>
              )}
            </div>
          </>
        ) : (
           <div className="text-center py-20">
             <p className="text-gray-400 mb-4">無法定位</p>
             <div className="flex flex-col gap-3 mt-6 px-10">
               <button onClick={getUserLocation} className="bg-gray-100 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-200 transition">重新定位</button>
               <button onClick={() => { setLocation({ lat: 25.046, lon: 121.517 }); setError(null); }} className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm shadow">使用台北車站測試</button>
             </div>
           </div>
        )}
      </main>
      <style>{`@keyframes slide-up {from{opacity:0;transform:translateY(20px);}to{opacity:1;transform:translateY(0);}} .animate-slide-up{animation:slide-up 0.4s ease-out forwards;}`}</style>
    </div>
  );
}