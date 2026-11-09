

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <Firebase_ESP_Client.h>
#include <addons/TokenHelper.h>
#include <SPI.h>
#define MFRC522_SPICLOCK 1000000u   
#include <MFRC522.h>
#include <Keypad.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <ESP32Servo.h>
#include <Preferences.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"

// ================= CẤU HÌNH =================
#define API_KEY ""
#define DATABASE_URL ""
#define USER_EMAIL ""
#define USER_PASSWORD ""

#define PIN_LENGTH        4      
#define DEFAULT_PIN       "" 
#define AUTO_LOCK_MS      5000   
#define PIN_TIMEOUT_MS    10000  
#define MAX_ATTEMPTS      5      
#define HEARTBEAT_MS      30000  
#define DEFAULT_CARD_UID  ""   
#define MAX_CARDS         20

// ---- CÔNG TẮC CHẨN ĐOÁN ----
#define USE_NETWORK 1

// ================= CHÂN CẮM + ĐỐI TƯỢNG =================
#define RFID_SS_PIN   5
#define RFID_RST_PIN  27
#define BUZZER_PIN    2
#define LED_GREEN_PIN 32
#define LED_RED_PIN   4     
#define SERVO_PIN     13

MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);
Servo doorServo;
LiquidCrystal_I2C lcd(0x27, 16, 2);

const byte KEYPAD_ROWS = 4, KEYPAD_COLS = 3;
char keys[KEYPAD_ROWS][KEYPAD_COLS] = { {'1','2','3'}, {'4','5','6'}, {'7','8','9'}, {'*','0','#'} };

byte rowPins[KEYPAD_ROWS] = {14, 25, 26, 33}; 
byte colPins[KEYPAD_COLS] = {15, 16, 17};

Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, KEYPAD_ROWS, KEYPAD_COLS);

FirebaseData fbdo;        
FirebaseData fbdoReq;     
FirebaseData fbdoPin;     
FirebaseData fbdoCards;   
FirebaseAuth auth;
FirebaseConfig config;
Preferences prefs;

// ================= TRẠNG THÁI CHUNG =================
volatile bool firebaseReady = false;
volatile uint8_t netStage = 0;            

String masterPIN = DEFAULT_PIN;           
String validCardUIDs[MAX_CARDS];
int cardCount = 0;
bool rfidPresent = true;
bool doorLocked = true;
String enteredPIN = "";
unsigned long lastKeyTime = 0, unlockedAt = 0;
unsigned long lockUntil = 0, uiResetAt = 0, lockTickAt = 0;
int lockLevel = 0;                        
const uint16_t* patPtr = NULL;            
uint8_t patLen = 0, patIdx = 0;
unsigned long patNextAt = 0;
char seedCard[MAX_CARDS][24];             
int seedCount = 0;
volatile bool cardsSynced = false;
int wrongAttempts = 0;
bool firstPinEvent = true, firstCardsApplied = false;
uint8_t shownNetStage = 255;
bool unkWaiting = false;                  
String unkUid = "";
unsigned long unkSince = 0;
unsigned long lastActivityTime = 0;       

volatile bool cmdOpenPending = false;     
volatile bool pinPending = false;
char pendingPin[24] = "";
volatile bool cardsDirty = false;         
volatile bool cardsListReady = false;     
char pendingCardUid[MAX_CARDS][24];
volatile int pendingCardCount = 0;
volatile int unkResult = 0;               

unsigned long lastRfidCheck = 0;
const unsigned long RFID_COOLDOWN = 2000;

// ================= HÀNG ĐỢI VIỆC CHO netTask =================
enum JobType : uint8_t { J_LOG, J_DOOR, J_SCAN, J_UNKNOWN, J_CLEAR_REQUEST };
struct NetJob {
  JobType type;
  bool flag;       
  double t;        
  char a[40];      
  char b[96];      
};
QueueHandle_t netQueue = NULL;

bool epochValid() { return time(nullptr) > 1700000000; }
double getEpochMillis() { time_t n; time(&n); return (double)n * 1000.0; }

void netPost(const NetJob& j) { if (netQueue) xQueueSend(netQueue, &j, 0); }   

void postLog(const String& method, const String& result) {
  NetJob j; memset(&j, 0, sizeof(j));
  j.type = J_LOG;
  j.t = epochValid() ? getEpochMillis() : 0;
  strncpy(j.a, method.c_str(), sizeof(j.a) - 1);
  strncpy(j.b, result.c_str(), sizeof(j.b) - 1);
  netPost(j);
}
void postDoor(bool locked, double autoLockAt) {
  NetJob j; memset(&j, 0, sizeof(j));
  j.type = J_DOOR; j.flag = locked; j.t = autoLockAt;
  netPost(j);
}
void postScan(const String& uid, bool registered) {
  NetJob j; memset(&j, 0, sizeof(j));
  j.type = J_SCAN; j.flag = registered;
  strncpy(j.a, uid.c_str(), sizeof(j.a) - 1);
  netPost(j);
}
void postUnknown(const String& uid) {
  NetJob j; memset(&j, 0, sizeof(j));
  j.type = J_UNKNOWN;
  strncpy(j.a, uid.c_str(), sizeof(j.a) - 1);
  netPost(j);
}
void postClearRequest() {
  NetJob j; memset(&j, 0, sizeof(j));
  j.type = J_CLEAR_REQUEST;
  netPost(j);
}

// ================= PHẦN MẠNG (CHỈ netTask GỌI) =================
String normalizeUid(String u) {
  u.replace("\"", ""); u.replace(" ", ""); u.replace(":", ""); u.replace("-", "");
  u.trim(); u.toUpperCase();
  return u;
}

bool isValidPin(const String& p) {
  if (p.length() != PIN_LENGTH) return false;
  for (unsigned int i = 0; i < p.length(); i++) if (!isDigit(p[i])) return false;
  return true;
}

void logTiming(const char* what, bool ok, unsigned long t0) {
  Serial.printf("[NET] %-14s %s (%lu ms)\n", what, ok ? "OK " : "LOI", millis() - t0);
}

void fbPushLog(const NetJob& j) {
  unsigned long t0 = millis();
  FirebaseJson json;
  json.set("time", j.t > 0 ? j.t : getEpochMillis());
  json.set("method", j.a);
  json.set("result", j.b);
  bool ok = Firebase.RTDB.pushJSON(&fbdo, "/logs", &json);
  logTiming("ghi log", ok, t0);
  if (!ok) Serial.println("     " + fbdo.errorReason());
}

void fbSetDoor(const NetJob& j) {
  unsigned long t0 = millis();
  FirebaseJson json;
  json.set("doorLocked", j.flag);
  json.set("autoLockAt", j.t);
  bool ok = Firebase.RTDB.updateNode(&fbdo, "/status", &json);
  logTiming(j.flag ? "trang thai KHOA" : "trang thai MO", ok, t0);
  if (!ok) Serial.println("     " + fbdo.errorReason());
}

void fbPublishScan(const char* uid, bool registered) {
  unsigned long t0 = millis();
  static int scanSeq = 0;
  FirebaseJson json;
  json.set("uid", uid);
  json.set("registered", registered);
  json.set("seq", ++scanSeq);
  json.set("time", epochValid() ? getEpochMillis() : (double)millis());
  Firebase.RTDB.setJSON(&fbdo, "/config/lastScan", &json);   
  logTiming("gui UID the", true, t0);
}

bool fbRegisterModeOn() {
  if (Firebase.RTDB.getBool(&fbdo, "/config/registerMode")) return fbdo.boolData();
  return false;
}

void fbClearRequest() {
  unsigned long t0 = millis();
  Firebase.RTDB.deleteNode(&fbdo, "/status/openRequest");
  logTiming("xoa yeu cau", true, t0);
}

void fbSendDeviceStatus() {
  FirebaseJson devJson;
  devJson.set("keypad", true);
  devJson.set("lcd", true);
  devJson.set("buzzer", true);
  devJson.set("rfid", rfidPresent);
  Firebase.RTDB.setJSON(&fbdo, "/status/devices", &devJson);
  Firebase.RTDB.setInt(&fbdo, "/status/autoLockSec", AUTO_LOCK_MS / 1000);
}

void fbHeartbeat() {
  if (!epochValid()) return;
  unsigned long t0 = millis();
  Firebase.RTDB.setDouble(&fbdo, "/status/lastUpdate", getEpochMillis());
  logTiming("heartbeat", true, t0);
}

void fbRefreshCards() {
  unsigned long t0 = millis();
  cardsDirty = false;       
  if (!Firebase.RTDB.getJSON(&fbdo, "/cards")) {
    logTiming("doc /cards", false, t0);
    cardsDirty = true;      
    vTaskDelay(pdMS_TO_TICKS(3000));
    return;
  }
  int n = 0;
  if (fbdo.dataType() == "json") {
    String raw = fbdo.jsonString();
    int pos = 0;
    while (n < MAX_CARDS) {
      int k = raw.indexOf("\"uid\"", pos);
      if (k < 0) break;
      pos = k + 5;
      int c = pos;
      while (c < (int)raw.length() && raw[c] == ' ') c++;
      if (c >= (int)raw.length() || raw[c] != ':') continue;       
      int q1 = raw.indexOf('"', c);
      if (q1 < 0) break;
      int q2 = raw.indexOf('"', q1 + 1);
      if (q2 < 0) break;
      String uid = normalizeUid(raw.substring(q1 + 1, q2));
      pos = q2 + 1;
      if (uid.length() > 0) { strncpy(pendingCardUid[n], uid.c_str(), 23); pendingCardUid[n][23] = '\0'; n++; }
    }
    if (n == 0) return;
  }
  
  if (!cardsSynced && seedCount > 0) {
    int pushed = 0;
    bool allOk = true;
    for (int i = 0; i < seedCount; i++) {
      bool found = false;
      for (int j = 0; j < n; j++) if (String(pendingCardUid[j]) == String(seedCard[i])) { found = true; break; }
      if (found) continue;
      FirebaseJson c;
      c.set("uid", seedCard[i]);
      c.set("owner", "The co san tren thiet bi");
      if (Firebase.RTDB.pushJSON(&fbdo, "/cards", &c)) pushed++;
      else allOk = false;
    }
    if (!allOk) {                       
      cardsDirty = true;
      vTaskDelay(pdMS_TO_TICKS(3000));
      return;
    }
    if (pushed > 0) {
      cardsSynced = true;
      cardsDirty = true;                
      return;
    }
  }
  cardsSynced = true;
  pendingCardCount = n;
  cardsListReady = true;
}

void reqStreamCallback(FirebaseStream data) {
  if (data.dataType() == "null") return;      
  cmdOpenPending = true;
}
void pinStreamCallback(FirebaseStream data) {
  if (data.dataType() == "string") {
    strncpy(pendingPin, data.stringData().c_str(), sizeof(pendingPin) - 1);
    pendingPin[sizeof(pendingPin) - 1] = '\0';
    pinPending = true;
  }
}
void cardsStreamCallback(FirebaseStream data) { cardsDirty = true; }
void streamTimeoutCallback(bool timeout) { }

bool netStartOnline() {
  Serial.println("[NET] WiFi OK, IP: " + WiFi.localIP().toString());
  netStage = 1;

  configTime(7 * 3600, 0, "pool.ntp.org", "time.nist.gov");     
  struct tm ti;
  int tries = 0;
  while (!getLocalTime(&ti, 500) && tries < 10) tries++;

  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  auth.user.email = USER_EMAIL;
  auth.user.password = USER_PASSWORD;
  config.token_status_callback = tokenStatusCallback;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);
  
  fbdo.setBSSLBufferSize(1024, 512);      fbdo.setResponseSize(1024);
  fbdoReq.setBSSLBufferSize(1024, 512);   fbdoReq.setResponseSize(512);
  fbdoPin.setBSSLBufferSize(1024, 512);   fbdoPin.setResponseSize(512);
  fbdoCards.setBSSLBufferSize(2048, 512); fbdoCards.setResponseSize(1024);
  fbdoReq.keepAlive(5, 5, 1); fbdoPin.keepAlive(5, 5, 1); fbdoCards.keepAlive(5, 5, 1);   

  unsigned long t0 = millis();
  while (!Firebase.ready() && millis() - t0 < 20000) { vTaskDelay(pdMS_TO_TICKS(300)); }
  if (!Firebase.ready()) return false;
  Serial.println("[NET] Dang nhap Firebase THANH CONG");

  Firebase.RTDB.deleteNode(&fbdo, "/status/openRequest");

  { NetJob j; memset(&j, 0, sizeof(j)); j.type = J_DOOR; j.flag = true; j.t = 0; fbSetDoor(j); }
  fbSendDeviceStatus();

  if (Firebase.RTDB.getString(&fbdo, "/config/masterPin")) {
    String fbPin = fbdo.stringData();
    fbPin.trim();
    if (isValidPin(fbPin)) {
      strncpy(pendingPin, fbPin.c_str(), sizeof(pendingPin) - 1);
      pendingPin[sizeof(pendingPin) - 1] = '\0';
      pinPending = true;
    } else {
      Firebase.RTDB.setString(&fbdo, "/config/masterPin", masterPIN);
    }
  } else if (fbdo.httpCode() == 200 && fbdo.dataType() == "null") {
    Firebase.RTDB.setString(&fbdo, "/config/masterPin", masterPIN);
  }
  cardsDirty = true;                                  

  Firebase.RTDB.beginStream(&fbdoReq, "/status/openRequest");
  Firebase.RTDB.setStreamCallback(&fbdoReq, reqStreamCallback, streamTimeoutCallback);
  Firebase.RTDB.beginStream(&fbdoPin, "/config/masterPin");
  Firebase.RTDB.setStreamCallback(&fbdoPin, pinStreamCallback, streamTimeoutCallback);
  Firebase.RTDB.beginStream(&fbdoCards, "/cards");
  Firebase.RTDB.setStreamCallback(&fbdoCards, cardsStreamCallback, streamTimeoutCallback);

  { NetJob j; memset(&j, 0, sizeof(j)); j.type = J_LOG; j.t = epochValid() ? getEpochMillis() : 0;
    strncpy(j.a, "System", sizeof(j.a) - 1); strncpy(j.b, "ESP32 khoi dong (online)", sizeof(j.b) - 1); fbPushLog(j); }
  fbHeartbeat();

  firebaseReady = true;
  netStage = 2;
  return true;
}

void netProcessJob(NetJob& j) {
  switch (j.type) {
    case J_LOG:           fbPushLog(j); break;
    case J_DOOR:          fbSetDoor(j); break;
    case J_SCAN:          fbPublishScan(j.a, j.flag); break;
    case J_CLEAR_REQUEST: fbClearRequest(); break;
    case J_UNKNOWN: {
      bool reg = fbRegisterModeOn();
      unkResult = reg ? 1 : 2;               
      if (reg) {
        fbPublishScan(j.a, false);
        Firebase.RTDB.setBool(&fbdo, "/config/registerMode", false);   
        NetJob l; memset(&l, 0, sizeof(l)); l.type = J_LOG; l.t = epochValid() ? getEpochMillis() : 0;
        strncpy(l.a, "System", sizeof(l.a) - 1); strncpy(l.b, "Doc the moi de dang ky", sizeof(l.b) - 1);
        fbPushLog(l);                                                   
      }
      break;
    }
  }
}

void netProcessBatch(NetJob* b, int n) {
  if (!firebaseReady) {                                  
    for (int i = 0; i < n; i++) if (b[i].type == J_UNKNOWN) unkResult = 2;
    return;
  }
  for (int i = 0; i < n; i++) if (b[i].type == J_DOOR) netProcessJob(b[i]);   
  for (int i = 0; i < n; i++)
    if (b[i].type == J_CLEAR_REQUEST || b[i].type == J_SCAN || b[i].type == J_UNKNOWN) netProcessJob(b[i]);
  for (int i = 0; i < n; i++)
    if (b[i].type == J_LOG) netProcessJob(b[i]);
}

void netTask(void* param) {
  WiFi.setSleep(true);                    
  Serial.println("[NET] Dang cho ket noi WiFi tu WiFiManager...");

  unsigned long lastOnlineTry = 0, lastHeartbeat = millis();
  for (;;) {
    bool wifiUp = (WiFi.status() == WL_CONNECTED);

    if (!wifiUp) {
      firebaseReady = false;
      netStage = 0;
      WiFi.reconnect();
      vTaskDelay(pdMS_TO_TICKS(5000));
    } else if (!firebaseReady && (lastOnlineTry == 0 || millis() - lastOnlineTry > 30000)) {
      lastOnlineTry = millis();
      netStartOnline();
      lastHeartbeat = millis();
    }
    if (wifiUp && netStage == 0) netStage = firebaseReady ? 2 : 1;

    static NetJob batch[24];
    if (xQueueReceive(netQueue, &batch[0], pdMS_TO_TICKS(200)) == pdTRUE) {
      int n = 1;
      while (n < 24 && xQueueReceive(netQueue, &batch[n], 0) == pdTRUE) n++;
      netProcessBatch(batch, n);
    }

    if (firebaseReady) {
      if (cardsDirty && !cardsListReady) fbRefreshCards();
      if (millis() - lastHeartbeat > HEARTBEAT_MS) { lastHeartbeat = millis(); fbHeartbeat(); }
    }
  }
}

// ================= NVS (CHỈ loop() GỌI) =================
void loadConfigFromNVS() {
  prefs.begin("lock_data", false);                  
  masterPIN = prefs.getString("pass", DEFAULT_PIN);
  if (!isValidPin(masterPIN)) {                     
    masterPIN = DEFAULT_PIN;
    prefs.putString("pass", masterPIN);
  }
  bool hasCards = prefs.isKey("cards");
  String cs = hasCards ? prefs.getString("cards", "") : String(DEFAULT_CARD_UID);
  prefs.end();
  cardCount = 0;
  int start = 0;
  while (start < (int)cs.length() && cardCount < MAX_CARDS) {
    int comma = cs.indexOf(',', start);
    if (comma < 0) comma = cs.length();
    String uid = cs.substring(start, comma);
    if (uid.length() > 0) validCardUIDs[cardCount++] = uid;
    start = comma + 1;
  }
}
void savePinToNVS() { prefs.begin("lock_data", false); prefs.putString("pass", masterPIN); prefs.end(); }
void saveCardsToNVS() {
  String cs = "";
  for (int i = 0; i < cardCount; i++) { if (i > 0) cs += ","; cs += validCardUIDs[i]; }
  prefs.begin("lock_data", false); prefs.putString("cards", cs); prefs.end();
}
bool isCardValid(const String& uid) {
  for (int i = 0; i < cardCount; i++) if (validCardUIDs[i] == uid) return true;
  return false;
}

// ================= GIAO DIỆN LCD / LED / CÒI =================
void lcdLine(uint8_t row, String s) {
  while (s.length() < 16) s += ' ';
  lcd.setCursor(0, row);
  lcd.print(s.substring(0, 16));
}
const char* netText() { return netStage == 2 ? "Online" : (netStage == 1 ? "Ket noi WiFi" : "Offline"); }

void showIdlePrompt() {
  if (rfidPresent) lcdLine(0, "He thong khoa");
  else             lcdLine(0, "PIN (RFID loi)");   
  lcdLine(1, netText());
  shownNetStage = netStage;
}

const uint16_t PAT_KEY[]  = {15};          
const uint16_t PAT_CARD[] = {60};          
const uint16_t PAT_OK[]   = {30, 80, 30};  
const uint16_t PAT_ERR[]  = {800};
const uint16_t PAT_NOREAD[] = {120, 80, 120};   // 2 tiếng bíp ngắn: không đọc được mã thẻ         
const uint16_t PAT_TICK[] = {10};    

void beepPlay(const uint16_t* p, uint8_t n) {
  patPtr = p; patLen = n; patIdx = 0;
  tone(BUZZER_PIN, 2000); 
  patNextAt = millis() + p[0];
}

void beepTick() {
  if (!patPtr || millis() < patNextAt) return;
  patIdx++;
  if (patIdx >= patLen) { noTone(BUZZER_PIN); patPtr = NULL; return; }
  
  if (patIdx % 2 == 0) {
    tone(BUZZER_PIN, 2000);
  } else {
    noTone(BUZZER_PIN);
  }
  patNextAt += patPtr[patIdx];
}

// ================= MỞ / KHÓA / BÁO LỖI =================
void doUnlock(bool fromWeb, const char* method) {
  doorLocked = false;
  
  doorServo.write(90); // Mở dứt khoát ngay lập tức
  
  digitalWrite(LED_GREEN_PIN, HIGH);
  digitalWrite(LED_RED_PIN, LOW);
  beepPlay(PAT_OK, 3);
  wrongAttempts = 0;
  lockLevel = 0;
  lcdLine(0, "MO KHOA");

  lcdLine(1, "THANH CONG"); 
  unlockedAt = millis();
  uiResetAt = 0;
  enteredPIN = "";
  lastActivityTime = millis(); 

  postDoor(false, epochValid() ? getEpochMillis() + AUTO_LOCK_MS : -1);
  postLog(method, "Mo thanh cong");
  if (fromWeb) postClearRequest();
}

void doLock(const char* method) {
  doorLocked = true;
  
  doorServo.write(0);  // Đóng dứt khoát ngay lập tức
  
  digitalWrite(LED_GREEN_PIN, LOW);
  digitalWrite(LED_RED_PIN, LOW);          
  unlockedAt = 0;
  enteredPIN = "";
  lastActivityTime = millis(); 
  showIdlePrompt();                        

  postDoor(true, 0);
  postLog(method, "Da khoa cua");
}

void wrongAlert(const String& lcdTitle, const String& logDetail, const char* method) {
  digitalWrite(LED_RED_PIN, HIGH);
  beepPlay(PAT_ERR, 1);
  wrongAttempts++;
  lcdLine(0, lcdTitle);
  lcdLine(1, "Canh bao: " + String(wrongAttempts) + "/" + String(MAX_ATTEMPTS));
  uiResetAt = millis() + 2000;             
  enteredPIN = "";
  postLog(method, "That bai: " + logDetail);

  if (wrongAttempts >= MAX_ATTEMPTS) {
    int secs = (lockLevel == 0) ? 10 : (lockLevel == 1) ? 15 : 60;
    if (lockLevel < 2) lockLevel++;
    wrongAttempts = 0;
    lockUntil = millis() + (unsigned long)secs * 1000UL;
    lockTickAt = millis() + 1500;          
    uiResetAt = lockUntil;                 
    postLog("System", "Khoa tam " + String(secs) + "s do nhap sai nhieu lan");
  }
}

void applyPendingPin() {
  String np = String(pendingPin);
  np.trim();
  if (!isValidPin(np)) return;
  if (np != masterPIN) {
    masterPIN = np;
    savePinToNVS();
    if (!firstPinEvent) {                  
      lastActivityTime = millis(); 
      beepPlay(PAT_OK, 3);         
      lcdLine(0, "Da doi ma PIN");
      lcdLine(1, "thanh cong!");
      uiResetAt = millis() + 2000; 
      postLog("System", "Da cap nhat ma PIN moi");
    }
  }
  firstPinEvent = false;
}

void applyPendingCards() {
  int n = pendingCardCount;
  bool changed = (n != cardCount);
  
  for (int i = 0; !changed && i < n; i++) {
    if (String(pendingCardUid[i]) != validCardUIDs[i]) changed = true;
  }
  
  if (changed) {
    String deletedUIDs = "";
    for (int i = 0; i < cardCount; i++) {
      bool stillExists = false;
      for (int j = 0; j < n; j++) {
        if (validCardUIDs[i] == String(pendingCardUid[j])) { stillExists = true; break; }
      }
      if (!stillExists) deletedUIDs += validCardUIDs[i] + " ";
    }
    
    String addedUIDs = "";
    for (int i = 0; i < n; i++) {
      bool isNew = true;
      for (int j = 0; j < cardCount; j++) {
        if (String(pendingCardUid[i]) == validCardUIDs[j]) { isNew = false; break; }
      }
      if (isNew) addedUIDs += String(pendingCardUid[i]) + " ";
    }
    
    deletedUIDs.trim();
    addedUIDs.trim();
    
    for (int i = 0; i < n; i++) validCardUIDs[i] = String(pendingCardUid[i]);
    cardCount = n;
    saveCardsToNVS();
    
    if (firstCardsApplied) {
      lastActivityTime = millis(); 
      beepPlay(PAT_OK, 3);         
      lcdLine(0, "Cap nhat the:");
      lcdLine(1, "Tong " + String(n) + " the luu"); 
      uiResetAt = millis() + 2500; 
      
      if (deletedUIDs != "") postLog("System", "Da xoa the UID: " + deletedUIDs);
      if (addedUIDs != "")   postLog("System", "Da them the UID: " + addedUIDs);
      
      if (deletedUIDs == "" && addedUIDs == "") postLog("System", "Da cap nhat danh sach the");
    }
  }
  firstCardsApplied = true;
  cardsListReady = false;                  
}

// ================= RFID: KHỞI TẠO + TỰ KIỂM TRA =================
void rfidInit() {
  rfid.PCD_Init();                                   // reset + bật anten
  pinMode(RFID_RST_PIN, OUTPUT);
  digitalWrite(RFID_RST_PIN, HIGH);
  rfid.PCD_SetAntennaGain(MFRC522::RxGain_max);      // tăng độ nhạy thu để đọc thẻ ổn định hơn
  delay(4);
}

byte rfidState() {
  byte ver = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  if (ver == 0x00 || ver == 0xFF) return 2;
  byte tx = rfid.PCD_ReadRegister(MFRC522::TxControlReg);
  return ((tx & 0x03) == 0x03) ? 0 : 1;
}

void rfidPrintState(const char* tag) {
  byte st = rfidState();
  Serial.printf("[RFID] %s: VersionReg=0x%02X TxControl=0x%02X -> %s\n", tag,
                rfid.PCD_ReadRegister(MFRC522::VersionReg), rfid.PCD_ReadRegister(MFRC522::TxControlReg),
                st == 0 ? "OK" : (st == 1 ? "anten dang tat" : "CHIP KHONG PHAN HOI (kiem tra day SPI, nguon 3.3V, chan 5/18/19/23/27)"));
}

// ================= QUÉT PHÍM + THẺ =================
void handleHardware() {
  char key = keypad.getKey();

  if (lockUntil) {
    if (millis() < lockUntil) return;      
    lockUntil = 0;
  }
  if (!doorLocked) return;                 

  if (unkWaiting) {
    int r = unkResult;
    if (!r && millis() - unkSince > 8000) r = 2;           
    if (r) {
      unkWaiting = false;
      unkResult = 0;
      if (r == 1) {                                        
        lcdLine(0, "Da doc the moi");
        lcdLine(1, unkUid);
        beepPlay(PAT_OK, 3);
        uiResetAt = millis() + 2500;
      } else {
        wrongAlert("THE KHONG HOP LE", "The la (UID: " + unkUid + ")", "RFID"); 
      }
    }
    return;
  }

  bool cardRead = false;
  if (rfid.PICC_IsNewCardPresent()) {
    cardRead = rfid.PICC_ReadCardSerial();
    if (!cardRead) {
      rfid.PCD_AntennaOff();
      delay(5);
      rfid.PCD_AntennaOn();
      Serial.println("[RFID] Thay the nhung doc UID that bai -> reset the, thu lai (dua the sat dau doc hon)");

      // Báo cho người dùng biết (tối đa 1 lần / 1.5 giây để không nháy liên tục). Không tính là sai mật khẩu.
      static unsigned long lastReadFailNotice = 0;
      if (millis() - lastReadFailNotice > 1500) {
        lastReadFailNotice = millis();
        lastActivityTime = millis();                 // bật đèn nền LCD
        enteredPIN = "";                             // bỏ dở PIN đang nhập (nếu có) để màn hình trở về bình thường
        lcdLine(0, "KHONG DOC DUOC");
        lcdLine(1, "Dat the sat hon");
        beepPlay(PAT_NOREAD, 3);
        uiResetAt = millis() + 2000;                 // sau 2 giây tự về màn hình chờ
      }
    }
  }
  if (cardRead) {
    if (millis() - lastRfidCheck < RFID_COOLDOWN) {
        rfid.PICC_HaltA();
        rfid.PCD_StopCrypto1();
        return; 
    }
    lastRfidCheck = millis();
    
    lastActivityTime = millis(); 
    String uid = "";
    for (byte i = 0; i < rfid.uid.size; i++) {
      if (rfid.uid.uidByte[i] < 0x10) uid += "0";
      uid += String(rfid.uid.uidByte[i], HEX);
    }
    uid.toUpperCase();
    Serial.println("[RFID] Quet the UID = " + uid + (isCardValid(uid) ? "  (hop le)" : "  (chua dang ky)"));
    if (isCardValid(uid)) {
      postScan(uid, true);                 
      doUnlock(false, "RFID");
    } else {
      unkWaiting = true;
      unkUid = uid;
      unkSince = millis();
      unkResult = 0;
      enteredPIN = "";                     
      lcdLine(0, "Dang kiem tra");
      lcdLine(1, "the...");
      postUnknown(uid);
    }
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    return;
  }

  if (enteredPIN.length() > 0 && millis() - lastKeyTime > PIN_TIMEOUT_MS) {
    enteredPIN = "";
    showIdlePrompt();
  }

  if (key) {
    lastActivityTime = millis(); 
    beepPlay(PAT_KEY, 1);                  
    lastKeyTime = millis();
    if (key == '*') {                      
      enteredPIN = "";
      digitalWrite(LED_RED_PIN, LOW);
      showIdlePrompt();
    } else if (key == '#') {
    } else if (enteredPIN.length() < PIN_LENGTH) {
      enteredPIN += key;
      lcdLine(0, "Nhap ma PIN");
      String stars = "";
      for (unsigned int i = 0; i < enteredPIN.length(); i++) stars += '*';
      lcdLine(1, "PIN: " + stars);
      if (enteredPIN.length() == PIN_LENGTH) {          
        if (enteredPIN == masterPIN) doUnlock(false, "PIN");
        else wrongAlert("SAI MAT KHAU", "Sai PIN", "PIN"); 
      }
    }
  }
}

// ================= SETUP / LOOP =================
void setup() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0); 
  
  Serial.begin(115200);
  setCpuFrequencyMhz(80); 

  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  pinMode(LED_GREEN_PIN, OUTPUT);
  pinMode(LED_RED_PIN, OUTPUT);
  digitalWrite(LED_GREEN_PIN, LOW);
  digitalWrite(LED_RED_PIN, LOW);

  // 1. KHỞI TẠO MÀN HÌNH VÀ PHẦN CỨNG TRƯỚC TIÊN ĐỂ CHẠY OFFLINE
  Wire.begin();
  lcd.init();
  lcd.backlight();
  lcdLine(0, "Khoi dong...");
  lcdLine(1, "Ket noi WiFi...");
  lastActivityTime = millis(); 
  keypad.setDebounceTime(5);

  SPI.begin();
  rfidInit();
  rfidPresent = (rfidState() != 2);                
  rfidPrintState("Luc khoi dong");

  ESP32PWM::allocateTimer(0);              
  doorServo.setPeriodHertz(50);
  doorServo.attach(SERVO_PIN, 500, 2400);
  doorServo.write(0);                      

  loadConfigFromNVS();                     
  seedCount = cardCount;                   
  for (int i = 0; i < cardCount; i++) { strncpy(seedCard[i], validCardUIDs[i].c_str(), 23); seedCard[i][23] = '\0'; }

  // 2. KIỂM TRA WIFI VỚI THỜI GIAN CHỜ 10 GIÂY
#if USE_NETWORK
  WiFiManager wifiManager;
  wifiManager.setConfigPortalTimeout(10);
  
  Serial.println("Dang kiem tra ket noi Wi-Fi...");
  
  if (!wifiManager.autoConnect("KhoaCua_ESP32", "12345678")) {
    Serial.println("Ket noi WiFi that bai, chuyen sang che do OFFLINE...");
  } else {
    Serial.println("Da ket noi Wi-Fi thanh cong!");
    Serial.print("Dia chi IP: ");
    Serial.println(WiFi.localIP());
  }

  WiFi.setTxPower(WIFI_POWER_11dBm);
#else
  Serial.println("[DIAG] USE_NETWORK = 0: da tat WiFi/Firebase, chi chay phan cung (che do Offline)");
#endif

  // WiFi vừa bật là lúc dòng điện tăng vọt, dễ làm RC522 reset: khởi tạo lại cho chắc
  rfidInit();
  rfidPresent = (rfidState() != 2);
  rfidPrintState("Sau khi WiFi xong");

  showIdlePrompt();                      

#if USE_NETWORK
  netQueue = xQueueCreate(24, sizeof(NetJob));
  xTaskCreatePinnedToCore(netTask, "net", 16384, NULL, 1, NULL, 0);   
#endif
}

void loop() {
  unsigned long now = millis();

  beepTick();

  if (lockUntil && now < lockUntil && now >= lockTickAt) {
    lockTickAt = now + 1000;
    lcdLine(0, "HE THONG KHOA"); 
    lcdLine(1, "Thu lai sau: " + String((lockUntil - now + 999) / 1000) + "s");
    // beepPlay(PAT_TICK, 1); // Đã tắt hoàn toàn tiếng "bíp" đếm ngược
  }

  if (cmdOpenPending) {
    cmdOpenPending = false;
    if (doorLocked) doUnlock(true, "Web");
    else postClearRequest();               
  }

  if (!doorLocked && unlockedAt && millis() - unlockedAt >= AUTO_LOCK_MS) doLock("System");

  bool idle = doorLocked && enteredPIN.length() == 0 && !unkWaiting && !lockUntil;
  if (pinPending && idle) { pinPending = false; applyPendingPin(); }
  if (cardsListReady && idle) applyPendingCards();

  if (uiResetAt && now >= uiResetAt) {
    uiResetAt = 0;
    digitalWrite(LED_RED_PIN, LOW);
    if (doorLocked && enteredPIN.length() == 0 && !unkWaiting) showIdlePrompt();
  }
  if (idle && !uiResetAt && shownNetStage != netStage) showIdlePrompt();

  static unsigned long lastRfidHealth = 0, rfidRecoveries = 0;
  static byte rfidFail = 0;
  static bool rfidWasBad = false;
  if (millis() - lastRfidHealth > 300) {
    lastRfidHealth = millis();
    byte st = rfidState();
    if (st != 0) {
      if (!rfidWasBad) { rfidPrintState("Phat hien bat thuong"); rfidWasBad = true; }
      rfidInit();                                    // reset chip + cấu hình lại + bật anten
      st = rfidState();
      if (st == 0) { rfidRecoveries++; rfidWasBad = false; Serial.printf("[RFID] Da tu khoi phuc (lan thu %lu)\n", rfidRecoveries); }
    }
    if (st == 2) { if (rfidFail < 255) rfidFail++; } else rfidFail = 0;
    bool nowPresent = (rfidFail < 10);
    if (nowPresent != rfidPresent) {
      rfidPresent = nowPresent;
      Serial.println(rfidPresent ? "[RFID] RC522 hoat dong tro lai" : "[RFID] RC522 khong phan hoi lien tuc -> bao loi");
      if (idle && !uiResetAt) showIdlePrompt();
    }
  }

  handleHardware();
  delay(2);

  static bool backlightOn = true;
  bool wantBacklight = (millis() - lastActivityTime <= 10000);
  if (wantBacklight != backlightOn) {
    backlightOn = wantBacklight;
    if (wantBacklight) lcd.backlight(); else lcd.noBacklight();
  }
}