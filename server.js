import SwiftUI
import CoreLocation
import Combine
import ActivityKit
import WidgetKit
import GoogleMobileAds

// MARK: - 1. Data Models

struct TrainResponse: Decodable {
    let success: Bool?
    let lastUpdate: String?
    let count: Int?
    let data: [BackendTrainData]?
    let trains: [BackendTrainData]?
    
    var list: [BackendTrainData] { return trains ?? data ?? [] }
}

struct BackendTrainData: Decodable {
    let trainNumber: String?
    let stationName: String?
    let destinationName: String?
    let countDown: String?
    let nowDateTime: String?
    let rawCrowd: BackendCrowdData?
}

struct BackendCrowdData: Decodable {
    let level1: String?
    let level2: String?
    let level3: String?
    let level4: String?
    let level5: String?
    let level6: String?
    let congestionLevel: String?

    enum CodingKeys: String, CodingKey {
        case Car1, Car2, Car3, Car4, Car5, Car6
        case Cart1L, Cart2L, Cart3L, Cart4L, Cart5L, Cart6L
        case CongestionLevel
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        func decodeAny(_ keys: [CodingKeys]) -> String? {
            for key in keys {
                if let val = try? container.decode(String.self, forKey: key) { return val }
                if let val = try? container.decode(Int.self, forKey: key) { return String(val) }
            }
            return nil
        }
        level1 = decodeAny([.Car1, .Cart1L])
        level2 = decodeAny([.Car2, .Cart2L])
        level3 = decodeAny([.Car3, .Cart3L])
        level4 = decodeAny([.Car4, .Cart4L])
        level5 = decodeAny([.Car5, .Cart5L])
        level6 = decodeAny([.Car6, .Cart6L])
        congestionLevel = decodeAny([.CongestionLevel])
    }
    
    var levels: [Int] {
        let raw = [level1, level2, level3, level4, level5, level6]
        return raw.compactMap { $0 }.compactMap { Int($0) }
    }
    
    var calculatedLevel: String {
        if let level = congestionLevel { return level }
        if let maxVal = levels.max() {
            if maxVal >= 4 { return "FULL" }
            if maxVal == 3 { return "HIGH" }
            if maxVal == 2 { return "MEDIUM" }
            return "LOW"
        }
        return "UNKNOWN"
    }
}

struct Train: Identifiable, Hashable {
    let id = UUID()
    let trainNumber: String
    let stationID: String
    let stationName: String
    let destination: String
    let lineNo: String
    let crowdLevel: String
    let carCrowd: [Int]
    let arrivalTime: Date
    
    var resolvedLineNo: String { lineNo }
    
    var lineColor: Color {
        if let info = ALL_LINES.first(where: { $0.code == lineNo }) { return info.color }
        return Color.gray
    }
    
    var displayDestination: String {
        if destination == "未知" || destination.isEmpty { return "..." }
        return formatDestination(lineCode: lineNo, destination: destination)
    }
}

// MARK: - 2. ViewModel
class LocationManager: NSObject, ObservableObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    @Published var location: CLLocation?
    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }
    func requestPermission() { manager.requestWhenInUseAuthorization(); manager.startUpdatingLocation() }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) { location = locations.last }
}

class MRTViewModel: ObservableObject {
    @Published var nearestStation: Station?
    @Published var trains: [Train] = []
    @Published var isLoading = false
    @Published var isManualSelection = false
    @Published var debugMessage: String = "準備載入資料..."
    
    private let apiURL = "https://my-tdx-api.onrender.com"
    private var updateTimer: Timer?
    
    private let dateFormatter: DateFormatter = {
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd HH:mm:ss"
        df.timeZone = TimeZone(identifier: "Asia/Taipei")
        return df
    }()
    
    init() {
        updateTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.checkAndUpdateLiveActivities()
        }
    }
    
    func updateLocation(userLocation: CLLocation) {
        if isManualSelection { return }
        var minDistance: Double = .greatestFiniteMagnitude
        var closest: Station?
        for station in STATIONS_DB {
            let stationLoc = CLLocation(latitude: station.lat, longitude: station.lon)
            let distance = userLocation.distance(from: stationLoc)
            if distance < minDistance { minDistance = distance; closest = station }
        }
        if let closest = closest, minDistance < 5000 {
            if self.nearestStation?.name != closest.name {
                self.nearestStation = closest
                fetchData()
            }
        }
    }
    
    func setStationManually(_ station: Station) {
        self.isManualSelection = true
        self.nearestStation = station
        self.trains = []
        fetchData()
    }
    
    func enableAutoLocation() {
        self.isManualSelection = false
        self.nearestStation = nil
        self.trains = []
        self.isLoading = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { self.isLoading = false }
    }
    
    func fetchData() {
        guard let station = nearestStation else { return }
        fetchDataForStation(station: station)
    }
    
    private func parseTime(_ timeStr: String?) -> Double {
        guard let timeStr = timeStr else { return 0 }
        if timeStr.contains(":") {
            let parts = timeStr.split(separator: ":")
            if parts.count == 2, let min = Double(parts[0]), let sec = Double(parts[1]) {
                return min * 60 + sec
            }
        }
        return 0
    }
    
    func fetchDataForStation(station: Station) {
        guard let url = URL(string: "\(apiURL)/api/station/\(station.id)") else { return }
        self.debugMessage = "🚀 請求中: \(station.name)..."
        
        URLSession.shared.dataTask(with: url) { data, response, error in
            DispatchQueue.main.async {
                if let error = error {
                    self.debugMessage = "❌ 連線失敗: \(error.localizedDescription)"
                    return
                }
                guard let data = data else { return }
                
                do {
                    let result = try JSONDecoder().decode(TrainResponse.self, from: data)
                    let rawList = result.list
                    
                    if rawList.isEmpty {
                        self.debugMessage = "⚠️ 無列車資料"
                        self.trains = []
                    } else {
                        var newTrains: [Train] = []
                        
                        for raw in rawList {
                            let sID = station.id
                            let lCode = station.lineCode
                            
                            let crowd = raw.rawCrowd?.calculatedLevel ?? "UNKNOWN"
                            let finalCrowd = (lCode == "Y") ? "UNKNOWN" : crowd
                            let cars = raw.rawCrowd?.levels ?? []
                            
                            // 時間校正：ServerTime + 60s 緩衝
                            let serverTimeString = raw.nowDateTime ?? ""
                            let serverDate = self.dateFormatter.date(from: serverTimeString) ?? Date()
                            let secondsRemaining = self.parseTime(raw.countDown)
                            let arrivalDate = serverDate.addingTimeInterval(secondsRemaining + 60)
                            
                            let tDest = raw.destinationName ?? "未知"
                            
                            let train = Train(
                                trainNumber: raw.trainNumber ?? "",
                                stationID: sID,
                                stationName: station.name,
                                destination: tDest,
                                lineNo: lCode,
                                crowdLevel: finalCrowd,
                                carCrowd: cars,
                                arrivalTime: arrivalDate
                            )
                            
                            newTrains.push(train)
                        }
                        
                        self.trains = newTrains.sorted { $0.arrivalTime < $1.arrivalTime }
                        self.debugMessage = "✅ 顯示 \(self.trains.count) 班車"
                    }
                } catch {
                    self.debugMessage = "❌ 解析失敗"
                    print(error)
                }
            }
        }.resume()
    }
    
    func startOrUpdateActivity(for train: Train, stationName: String) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        Task {
            for activity in Activity<MRTGoWidgetAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
            let arrivalDate = train.arrivalTime
            let state = MRTGoWidgetAttributes.ContentState(
                estimatedArrivalTime: arrivalDate,
                currentStationName: stationName,
                destination: train.displayDestination,
                lineCode: train.resolvedLineNo,
                directionID: "\(train.resolvedLineNo)-unknown",
                status: "行駛中",
                crowdLevel: train.crowdLevel
            )
            try? Activity.request(attributes: MRTGoWidgetAttributes(stationID: train.stationID), content: .init(state: state, staleDate: arrivalDate.addingTimeInterval(120)), pushType: nil)
        }
    }
    
    func checkAndUpdateLiveActivities() {
        Task {
            for activity in Activity<MRTGoWidgetAttributes>.activities {
                if Date() > activity.content.state.estimatedArrivalTime.addingTimeInterval(120) {
                    await activity.end(nil, dismissalPolicy: .default)
                }
            }
        }
    }
}

// MARK: - 3. UI Views (Array Extension for easier append)
extension Array {
    mutating func push(_ element: Element) {
        self.append(element)
    }
}

struct ContentView: View {
    @StateObject var locationManager = LocationManager()
    @StateObject var viewModel = MRTViewModel()
    @ObservedObject var userPrefs = UserPreferences.shared
    @State private var showStationSheet = false
    @State private var showSettings = false
    @State private var now = Date()
    @State private var countdownValue: Int = 30
    
    let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()
    let fetchTimer = Timer.publish(every: 30, on: .main, in: .common).autoconnect()
    
    var body: some View {
        NavigationView {
            ZStack {
                Color.black.edgesIgnoringSafeArea(.all)
                VStack {
                    HStack {
                        Text(userPrefs.localized("捷運 Go")).font(.title).bold().foregroundColor(.white)
                        Spacer()
                        Button(action: { showSettings = true }) {
                            Image(systemName: "gearshape.fill").foregroundColor(.white).padding(8).background(Color.gray.opacity(0.3)).clipShape(Circle())
                        }
                    }.padding(.horizontal).padding(.top, 10)

                    if let station = viewModel.nearestStation {
                        StationHeaderView(
                            station: station,
                            isPinned: userPrefs.isPinned(stationID: station.id),
                            countdown: countdownValue,
                            onPinToggle: { userPrefs.togglePin(stationID: station.id); WidgetCenter.shared.reloadAllTimelines() },
                            onRefresh: { viewModel.fetchData(); countdownValue = 30 },
                            onSwitchStation: { viewModel.setStationManually($0) }
                        )
                        GroupedTrainsView(trains: viewModel.trains, now: now, viewModel: viewModel, currentStationName: station.name)
                        BottomControlBar(viewModel: viewModel, showStationSheet: $showStationSheet)
                    } else {
                        PinnedStationsView(onSelect: { viewModel.setStationManually($0) })
                        VStack(spacing: 20) {
                            if viewModel.isLoading { ProgressView().progressViewStyle(CircularProgressViewStyle(tint: .white)); Text("定位中...").foregroundColor(.gray) }
                            else { Button(userPrefs.localized("手動選站")) { showStationSheet = true }.padding().background(Color.blue).foregroundColor(.white).cornerRadius(10) }
                        }.padding(.bottom, 50)
                    }
                    if !viewModel.debugMessage.contains("✅") && !viewModel.debugMessage.isEmpty {
                        Text(viewModel.debugMessage).font(.caption2).foregroundColor(.white).padding(4).background(Color.red.opacity(0.8)).cornerRadius(4).padding(.bottom, 2)
                    }
                }
            }
            .navigationBarHidden(true)
            .onAppear { locationManager.requestPermission(); MobileAds.shared.start(completionHandler: nil) }
            .onChange(of: locationManager.location) { if let loc = $0 { viewModel.updateLocation(userLocation: loc) } }
            .onReceive(timer) { _ in now = Date(); if countdownValue > 0 { countdownValue -= 1 } }
            .onReceive(fetchTimer) { _ in if viewModel.nearestStation != nil { viewModel.fetchData(); countdownValue = 30 } }
            .sheet(isPresented: $showStationSheet) { StationSelectorView(isPresented: $showStationSheet, onSelect: { viewModel.setStationManually($0) }) }
            .sheet(isPresented: $showSettings) { SettingsView(isPresented: $showSettings) }
        }.preferredColorScheme(.dark)
    }
}

// MARK: - Subviews
struct GroupedTrainsView: View {
    let trains: [Train]
    let now: Date
    @ObservedObject var viewModel: MRTViewModel
    let currentStationName: String
    
    var body: some View {
        VStack {
            if trains.isEmpty { Spacer(); Text("目前無即時資料").foregroundColor(.gray); Spacer() }
            else { List(trains) { train in TrainRowView(train: train, now: now, viewModel: viewModel, currentStationName: currentStationName).listRowBackground(Color.gray.opacity(0.1)) }.listStyle(PlainListStyle()) }
        }
    }
}

struct TrainRowView: View {
    let train: Train
    let now: Date
    let viewModel: MRTViewModel
    let currentStationName: String
    @ObservedObject var userPrefs = UserPreferences.shared
    
    var body: some View {
        HStack {
            ZStack {
                Circle().fill(Color.gray.opacity(0.2)).frame(width: 65, height: 65)
                VStack(spacing: 0) {
                    let diff = train.arrivalTime.timeIntervalSince(now)
                    let remaining = max(0, Int(diff))
                    let steppedRemaining = (remaining / 5) * 5
                    
                    if steppedRemaining <= 30 {
                        Text(userPrefs.localized("即將")).font(.caption2).foregroundColor(.orange)
                        Text(userPrefs.localized("進站")).font(.caption).bold().foregroundColor(.orange)
                    } else {
                        let min = steppedRemaining / 60
                        let sec = steppedRemaining % 60
                        Text("\(min):\(String(format: "%02d", sec))").font(.title3).bold().foregroundColor(.blue).monospacedDigit()
                        Text(userPrefs.localized("後進站")).font(.caption2).foregroundColor(.gray)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(train.resolvedLineNo).font(.caption2).bold().padding(4).background(train.lineColor).foregroundColor(.white).cornerRadius(4)
                    Text(train.trainNumber).font(.caption2).foregroundColor(.gray)
                }
                HStack(spacing: 0) { Text(userPrefs.localized("往")); Text(" " + train.displayDestination).font(.title3).bold() }
                if !train.carCrowd.isEmpty { CarriageCrowdView(levels: train.carCrowd) }
                else if train.lineNo != "Y" { Text("載入擁擠度...").font(.caption2).foregroundColor(.gray) }
            }
            Spacer()
            Button(action: { viewModel.startOrUpdateActivity(for: train, stationName: currentStationName) }) {
                Image(systemName: "timer").font(.title2).foregroundColor(.white).padding(10).background(Color.blue).clipShape(Circle())
            }.buttonStyle(BorderlessButtonStyle())
        }
    }
}

struct CarriageCrowdView: View {
    let levels: [Int]
    func colorForLevel(_ level: Int) -> Color {
        switch level { case 1: return .green; case 2: return .yellow; case 3: return .orange; case 4: return .red; default: return .gray.opacity(0.3) }
    }
    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<levels.count, id: \.self) { index in
                VStack(spacing: 1) {
                    RoundedRectangle(cornerRadius: 2).fill(colorForLevel(levels[index])).frame(width: 12, height: 16)
                    Text("\(index + 1)").font(.system(size: 8)).foregroundColor(.gray)
                }
            }
            Text("擁擠度").font(.caption2).foregroundColor(.gray).padding(.leading, 4)
        }
    }
}

struct StationHeaderView: View {
    let station: Station
    var isPinned: Bool
    var countdown: Int
    var onPinToggle: () -> Void
    var onRefresh: () -> Void
    var onSwitchStation: (Station) -> Void
    var transferOptions: [Station] { getTransferStations(for: station.name) }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                if transferOptions.count > 1 {
                    HStack(spacing: 8) {
                        ForEach(transferOptions) { opt in
                            Button(action: { onSwitchStation(opt) }) {
                                Text(opt.lineCode).font(.caption).bold().padding(.horizontal, 8).padding(.vertical, 4)
                                    .background(opt.id == station.id ? opt.color : Color.gray.opacity(0.3)).foregroundColor(.white).cornerRadius(6)
                            }
                        }
                    }
                } else {
                    Text(station.lineCode).font(.caption).bold().padding(.horizontal, 8).padding(.vertical, 4).background(station.color).foregroundColor(.white).cornerRadius(6)
                }
                Text(station.name).font(.largeTitle).fontWeight(.black).foregroundColor(.white)
                Spacer()
                Button(action: onPinToggle) { Image(systemName: isPinned ? "heart.fill" : "heart").foregroundColor(isPinned ? .red : .gray).font(.title2).padding(8) }
            }
            HStack {
                Spacer()
                Button(action: onRefresh) { HStack(spacing: 4) { Image(systemName: "arrow.clockwise").rotationEffect(.degrees(Double(30 - countdown) * 12)); Text("\(countdown)s").font(.system(.caption, design: .monospaced)).foregroundColor(.gray) } }
            }
            ProgressView(value: Double(countdown), total: 30.0).tint(.blue).animation(.linear(duration: 1.0), value: countdown)
        }.padding().background(Color(UIColor.secondarySystemGroupedBackground)).cornerRadius(16).padding(.horizontal).padding(.top)
    }
}

struct BottomControlBar: View {
    @ObservedObject var viewModel: MRTViewModel
    @Binding var showStationSheet: Bool
    @ObservedObject var userPrefs = UserPreferences.shared
    var body: some View {
        VStack(spacing: 0) {
            BannerAdView().frame(width: 320, height: 50).background(Color.black).padding(.bottom, 10)
            HStack(spacing: 12) {
                if viewModel.isManualSelection { Button(action: { viewModel.enableAutoLocation() }) { HStack { Image(systemName: "location.fill"); Text(userPrefs.localized("切換回 GPS")).fontWeight(.bold) }.foregroundColor(.white).frame(maxWidth: .infinity).padding().background(Color.blue).cornerRadius(12) } }
                else { Button(action: { showStationSheet = true }) { HStack { Image(systemName: "list.bullet"); Text(userPrefs.localized("手動選站")).fontWeight(.bold) }.foregroundColor(.white).frame(maxWidth: .infinity).padding().background(Color.gray.opacity(0.3)).cornerRadius(12) } }
            }.padding().background(Color.black)
        }
    }
}

struct PinnedStationsView: View {
    @ObservedObject var userPrefs = UserPreferences.shared
    var onSelect: (Station) -> Void
    var body: some View {
        VStack(alignment: .leading) {
            Text(userPrefs.localized("已釘選車站")).font(.headline).foregroundColor(.gray).padding(.horizontal)
            if userPrefs.pinnedStationIDs.isEmpty { HStack { Spacer(); Text("請在車站頁面點擊 ❤️").foregroundColor(.gray).font(.caption); Spacer() }.padding(.vertical, 20) }
            else { ScrollView { LazyVStack(spacing: 10) { ForEach(userPrefs.pinnedStationIDs, id: \.self) { id in if let station = STATIONS_DB.first(where: { $0.id == id }) { Button(action: { onSelect(station) }) { HStack { Text(station.id).font(.caption).bold().padding(6).background(station.color).foregroundColor(.white).cornerRadius(4); Text(station.name).font(.title3).bold().foregroundColor(.white); Spacer(); Image(systemName: "chevron.right").foregroundColor(.gray) }.padding().background(Color(UIColor.secondarySystemGroupedBackground)).cornerRadius(12) } } } }.padding(.horizontal) } }
            Spacer()
        }
    }
}

struct SettingsView: View {
    @Binding var isPresented: Bool
    @ObservedObject var userPrefs = UserPreferences.shared
    var body: some View {
        NavigationView {
            Form {
                Section(header: Text(userPrefs.localized("一般設定"))) { Picker(userPrefs.localized("語言"), selection: $userPrefs.language) { Text("繁體中文").tag("zh-Hant"); Text("English").tag("en") } }
                Section(header: Text(userPrefs.localized("已釘選車站"))) { if userPrefs.pinnedStationIDs.isEmpty { Text("無").foregroundColor(.gray) } else { ForEach(userPrefs.pinnedStationIDs, id: \.self) { id in if let station = STATIONS_DB.first(where: { $0.id == id }) { HStack { Text(station.id).font(.caption).bold().padding(4).background(station.color).cornerRadius(4).foregroundColor(.white); Text(station.name) } } }.onDelete { userPrefs.pinnedStationIDs.remove(atOffsets: $0); WidgetCenter.shared.reloadAllTimelines() } } }
            }.navigationTitle(userPrefs.localized("設定")).navigationBarItems(trailing: Button(userPrefs.localized("完成")) { isPresented = false })
        }
    }
}

struct StationSelectorView: View {
    @Binding var isPresented: Bool; var onSelect: (Station) -> Void; @State private var selectedLineCode: String = "BL"; let lines: [LineInfo] = ALL_LINES; @ObservedObject var userPrefs = UserPreferences.shared
    var body: some View {
        NavigationView {
            VStack {
                ScrollView(.horizontal, showsIndicators: false) { HStack { ForEach(lines) { line in Button(action: { selectedLineCode = line.code }) { HStack { Text(line.code).font(.caption).bold().padding(6).background(line.color).foregroundColor(.white).cornerRadius(4); Text(line.name.replacingOccurrences(of: "線", with: "")) }.padding(.vertical, 8).padding(.horizontal, 12).background(selectedLineCode == line.code ? Color.gray.opacity(0.2) : Color.clear).cornerRadius(20) }.foregroundColor(.primary) } }.padding() }
                List(STATIONS_DB.filter { $0.lineCode == selectedLineCode }) { station in Button(action: { onSelect(station); isPresented = false }) { HStack { Text(station.id).font(.caption).bold().padding(6).background(Color.gray.opacity(0.2)).cornerRadius(4); Text(station.name).font(.headline) } } }.listStyle(PlainListStyle())
            }.navigationTitle(userPrefs.localized("手動選站")).navigationBarItems(leading: Button("關閉") { isPresented = false })
        }
    }
}

struct ContentView_Previews: PreviewProvider { static var previews: some View { ContentView() } }
