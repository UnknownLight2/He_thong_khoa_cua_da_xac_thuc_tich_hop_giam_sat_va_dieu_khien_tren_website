/*
  CẤU TRÚC DỮ LIỆU TRÊN FIREBASE REALTIME DATABASE (ESP32 sẽ đọc/ghi cùng cấu trúc này):

  /status/doorLocked        -> true/false  (CHỈ ESP32 ghi)
  /status/autoLockAt        -> giờ (ms) cửa sẽ tự khóa, 0 khi đang khóa (CHỈ ESP32 ghi)
  /status/openRequest       -> giờ server khi web yêu cầu mở cửa; ESP32 xóa sau khi xử lý
  /status/devices/keypad    -> true/false (OK/lỗi)
  /status/devices/lcd       -> true/false
  /status/devices/buzzer    -> true/false
  /status/devices/rfid      -> true/false
  /status/lastUpdate        -> timestamp (ESP32 ghi nhịp tim mỗi 10 giây; web dựa vào đây để biết online/offline)

  /config/masterPin         -> chuỗi mã PIN hiện tại

  /cards/<pushId>/uid       -> mã UID thẻ
  /cards/<pushId>/owner     -> tên chủ thẻ

  /logs/<pushId>/time       -> timestamp
  /logs/<pushId>/method     -> "RFID" / "PIN" / "System" / ...
  /logs/<pushId>/result     -> "Mo thanh cong" / "That bai: ..." / ...

  /roles/<uid>              -> "admin" hoặc "user"  (uid lấy từ Firebase Authentication)

*/

const db = firebase.database();
const auth = firebase.auth();

let currentRole = "guest"; // guest | user | admin
let currentUser = null;

// ---- Trạng thái dùng chung (khai báo ở ĐẦU file để mọi hàm gọi sớm cũng thấy) ----
let doorLockedState = true;
let prevLocked = null;        // trạng thái cửa lần trước (null = chưa có dữ liệu)
let autoLockSec = 5;          // ESP32 báo lên status/autoLockSec
let unlockSeenAt = null;      // lúc web thấy cửa chuyển sang "mở" (để đếm ngược)
let statusData = {};          // bản sao mới nhất của /status (mọi hiển thị đều tính từ đây)
let serverOffset = 0;         // chênh lệch đồng hồ trình duyệt so với đồng hồ Firebase

let adminRefs = [];
let cardsCache = {};          // uid (viết hoa) -> tên chủ thẻ
let currentPinValue = null;
let pinVisible = true;
let lastScanData = null;
let registering = false;
let scanBaseline = null;
let registerTimer = null;

// ================= ĐIỀU HƯỚNG (HAMBURGER + TAB) =================
const sidebar = document.getElementById("sidebar");
const overlay = document.getElementById("overlay");

document.getElementById("hamburger").addEventListener("click", () => {
  sidebar.classList.toggle("open");
  overlay.classList.toggle("show");
});
overlay.addEventListener("click", closeSidebar);

function closeSidebar() {
  sidebar.classList.remove("open");
  overlay.classList.remove("show");
}

document.querySelectorAll(".menu-item").forEach(item => {
  item.addEventListener("click", () => {
    const tabName = item.dataset.tab;
    document.querySelectorAll(".menu-item").forEach(m => m.classList.remove("active"));
    item.classList.add("active");
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.getElementById("tab-" + tabName).classList.add("active");
    document.getElementById("pageTitle").innerText =
      tabName.charAt(0).toUpperCase() + tabName.slice(1);
    closeSidebar();
  });
});

// ================= ĐĂNG NHẬP / ĐĂNG XUẤT =================
function openLoginModal() {
  document.getElementById("loginModal").classList.add("show");
  document.getElementById("loginError").classList.add("hidden");
}
function closeLoginModal() {
  document.getElementById("loginModal").classList.remove("show");
}

function doLogin() {
  const email = document.getElementById("loginEmail").value.trim();
  const pass = document.getElementById("loginPassword").value;
  const errBox = document.getElementById("loginError");

  auth.signInWithEmailAndPassword(email, pass)
    .then(() => closeLoginModal())
    .catch(err => {
      errBox.innerText = "Đăng nhập thất bại: " + err.message;
      errBox.classList.remove("hidden");
    });
}

function doLogout() {
  auth.signOut();
}

// Theo dõi trạng thái đăng nhập + lấy role từ /roles/<uid>
auth.onAuthStateChanged(user => {
  currentUser = user;
  if (user) {
    db.ref("roles/" + user.uid).once("value").then(snap => {
      currentRole = snap.exists() ? snap.val() : "user"; // mặc định "user" nếu chưa gán role
      applyRoleToUI(user.email);
    }).catch(err => {
      // In lỗi thật ra Console (F12) thay vì im lặng — giúp biết chính xác
      // nguyên nhân (vd: permission_denied do Security Rules chưa đúng/chưa Publish)
      console.error("Không đọc được role từ Firebase:", err.code, err.message);
      currentRole = "guest";
      applyRoleToUI(null);
      alert("Đăng nhập thành công nhưng không đọc được quyền (role).\n" +
            "Lỗi: " + err.message + "\nMở Console (F12) để xem chi tiết.");
    });
  } else {
    currentRole = "guest";
    applyRoleToUI(null);
  }
});

function applyRoleToUI(email) {
  const loginLink = document.getElementById("loginLink");
  const userInfo = document.getElementById("userInfo");
  const menuUser = document.getElementById("menuUser");
  if (currentRole === "guest") {
    loginLink.classList.remove("hidden");
    userInfo.classList.add("hidden");
    menuUser.classList.add("hidden");
  } else {
    loginLink.classList.add("hidden");
    userInfo.classList.remove("hidden");
    userInfo.innerHTML = email + " (" + currentRole + ") | " +
      '<a href="#" onclick="doLogout();return false;">Đăng xuất</a>';
    menuUser.classList.toggle("hidden", currentRole !== "admin");
  }
  renderDoorUI();

  const clearBtn = document.getElementById("clearLogsBtn");
  if (clearBtn) clearBtn.classList.toggle("hidden", currentRole !== "admin");

  // Dữ liệu chỉ admin được đọc: gắn listener SAU khi đã đăng nhập admin, gỡ khi không còn
  if (currentRole === "admin") attachAdminListeners(); else detachAdminListeners();

  // Nếu đang ở tab User mà bị mất quyền admin, quay về tab System
  if (currentRole !== "admin" && document.getElementById("tab-user").classList.contains("active")) {
    document.querySelector('.menu-item[data-tab="system"]').click();
  }
}

// ================= TAB SYSTEM: TRẠNG THÁI CỬA + THIẾT BỊ =================
// Đồng hồ của Firebase (trình duyệt có thể lệch giờ): mọi phép tính thời gian dùng đồng hồ này
db.ref(".info/serverTimeOffset").on("value", snap => { serverOffset = Number(snap.val()) || 0; });
function serverNow() { return Date.now() + serverOffset; }

// ESP32 ghi status/lastUpdate (nhịp tim) mỗi 10 giây. Quá 25 giây không có nhịp mới => coi là offline.
const HEARTBEAT_STALE_MS = 25000;

// true = online, false = offline, null = chưa có dữ liệu nhịp tim (thiết bị chưa từng báo giờ)
function isDeviceOnline() {
  const lu = Number(statusData.lastUpdate) || 0;
  if (!lu) return null;
  return (serverNow() - lu) < HEARTBEAT_STALE_MS;
}

function renderConnection() {
  const connEl = document.getElementById("statConnection");
  const lastEl = document.getElementById("statLastUpdate");
  const online = isDeviceOnline();
  const dev = (online === false) ? {} : (statusData.devices || {});   // offline: dữ liệu thiết bị cũ không còn đáng tin

  setBadge("dv_keypad", dev.keypad);
  setBadge("dv_lcd", dev.lcd);
  setBadge("dv_buzzer", dev.buzzer);
  setBadge("dv_rfid", dev.rfid);

  const lu = Number(statusData.lastUpdate) || 0;
  if (!lu) {
    connEl.innerText = "--";
    connEl.style.color = "";
    lastEl.innerText = "--";
    return;
  }

  const diffSec = Math.max(0, Math.round((serverNow() - lu) / 1000));
  lastEl.innerText = diffSec < 60 ? diffSec + "s trước"
    : diffSec < 3600 ? Math.round(diffSec / 60) + " phút trước"
    : Math.round(diffSec / 3600) + " giờ trước";

  if (!online) {
    connEl.innerText = "Offline";
    connEl.style.color = "var(--bad)";
    return;
  }
  const known = [dev.keypad, dev.lcd, dev.buzzer, dev.rfid].filter(v => v !== undefined);
  const okCount = known.filter(v => v === true).length;
  const allOk = known.length === 0 || okCount === known.length;
  connEl.innerText = allOk ? "Online" : "Online (" + okCount + "/" + known.length + " OK)";
  connEl.style.color = allOk ? "var(--ok)" : "var(--bad)";
}
setInterval(renderConnection, 1000);

// Giao thức điều khiển cửa (an toàn khi người dùng tải lại trang giữa chừng):
//   - Web CHỈ ghi status/openRequest = giờ server (= "tôi muốn mở cửa").
//   - ESP32 là nơi DUY NHẤT ghi status/doorLocked và status/autoLockAt (giờ sẽ tự khóa),
//     rồi xóa openRequest khi đã xử lý xong.
//   => Toàn bộ hiển thị dưới đây tính từ dữ liệu trên Firebase, không phụ thuộc biến cục bộ
//      của trang, nên F5 lúc nào cũng thấy đúng "đang gửi lệnh" / "đang mở, còn N giây".
function renderDoorUI() {
  const locked = statusData.doorLocked !== false;
  const icon = document.getElementById("doorIcon");
  const btn = document.getElementById("doorBtn");
  const hint = document.getElementById("doorHint");
  const guest = (currentRole === "guest");

  document.getElementById("doorStatusText").innerText = locked ? "Đang khóa" : "Đang mở";
  icon.innerHTML = locked ? "&#128274;" : "&#128275;"; // 🔒 / 🔓
  icon.classList.toggle("unlocked", !locked);

  if (locked) {
    const reqAt = Number(statusData.openRequest) || 0;          // có yêu cầu mở đang chờ ESP32?
    const ageSec = reqAt ? (serverNow() - reqAt) / 1000 : 0;
    if (reqAt && ageSec < 15) {
      btn.innerText = "Đang gửi lệnh...";
      btn.disabled = true;
      hint.innerText = "Đã gửi, chờ ESP32 xác nhận...";
    } else if (reqAt) {
      btn.innerText = "Gửi lại lệnh mở";
      btn.disabled = guest;
      hint.innerText = "ESP32 chưa phản hồi sau 15 giây. Kiểm tra kết nối thiết bị.";
    } else {
      btn.innerText = "Mở cửa";
      btn.disabled = guest;
      if (guest) hint.innerText = "Đăng nhập để mở cửa từ xa";
      else if (isDeviceOnline() === false) hint.innerText = "ESP32 đang offline, lệnh mở cửa sẽ không được thực hiện";
      else hint.innerText = "Cửa sẽ tự khóa sau " + autoLockSec + " giây, không cần khóa tay";
    }
    return;
  }

  // Cửa đang mở: KHÔNG có nút khóa, ESP32 tự khóa vào giờ autoLockAt
  btn.disabled = true;
  hint.innerText = "Cửa tự động khóa lại";
  let remain = null;
  const at = Number(statusData.autoLockAt);
  if (at > 1.6e12) {
    remain = Math.ceil((at - serverNow()) / 1000);             // tính theo giờ tuyệt đối ESP32 báo
  } else if (unlockSeenAt !== null) {
    remain = Math.ceil(autoLockSec - (Date.now() - unlockSeenAt) / 1000);  // dự phòng khi ESP32 chưa có giờ NTP
  }
  if (remain === null) btn.innerText = "Cửa sắp tự khóa";
  else if (remain > 0) btn.innerText = "Tự khóa sau " + remain + " giây";
  else if (remain > -6) btn.innerText = "Đang khóa lại...";
  else {
    btn.innerText = "Chưa thấy thiết bị khóa lại";
    hint.innerText = "Kiểm tra kết nối ESP32 (xem ô Kết nối thiết bị)";
  }
}
setInterval(renderDoorUI, 500);   // cập nhật bộ đếm ngược

db.ref("status").on("value", snap => {
  const data = snap.val() || {};
  statusData = data;
  const locked = data.doorLocked !== false; // mặc định coi là đang khóa nếu chưa có dữ liệu
  if (data.autoLockSec) autoLockSec = Number(data.autoLockSec) || 5;

  if (locked) unlockSeenAt = null;
  else if (prevLocked === true) unlockSeenAt = Date.now();   // dự phòng đếm ngược nếu thiếu autoLockAt
  prevLocked = locked;
  doorLockedState = locked;
  renderDoorUI();

  renderConnection();
});

function setBadge(id, ok) {
  const el = document.getElementById(id);
  if (ok === undefined) { el.innerText = "--"; el.className = "badge"; return; }
  el.innerText = ok ? "OK" : "LỖI";
  el.className = "badge " + (ok ? "ok" : "bad");
}

// Nút chỉ có MỘT việc: ghi "yêu cầu mở cửa" (giờ server). Việc mở, đếm giờ và tự khóa
// log "mở thành công" do chính ESP32 ghi sau khi đã quay servo.
document.getElementById("doorBtn").addEventListener("click", () => {
  if (currentRole === "guest" || statusData.doorLocked === false) return;
  const reqAt = Number(statusData.openRequest) || 0;
  if (reqAt && (serverNow() - reqAt) / 1000 < 15) return;     // đang chờ phản hồi, khỏi gửi chồng
  db.ref("status/openRequest").set(firebase.database.ServerValue.TIMESTAMP);
});

// ================= TAB USER: DỮ LIỆU CHỈ ADMIN ĐƯỢC ĐỌC =================
// cards / config / roles chỉ admin đọc được (theo Security Rules). Nếu gắn listener
// lúc trang vừa tải (còn là Guest) Firebase báo permission_denied và HỦY listener
// vĩnh viễn — đăng nhập xong cũng không tự chạy lại. Vì vậy chỉ gắn SAU KHI đăng nhập
// admin, và gỡ ra khi đăng xuất.
function escapeHtml(t) {
  return String(t == null ? "" : t).replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function attachAdminListeners() {
  if (adminRefs.length) return;
  const onErr = err => console.error("Lỗi đọc dữ liệu admin:", err.message);

  const cardsRef = db.ref("cards");
  cardsRef.on("value", snap => {
    const tbody = document.querySelector("#cardTable tbody");
    tbody.innerHTML = "";
    cardsCache = {};
    snap.forEach(child => {
      const c = child.val() || {};
      cardsCache[String(c.uid || "").toUpperCase()] = c.owner || "";
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(c.uid)}</td><td>${escapeHtml(c.owner)}</td>
        <td><button class="btn danger" onclick="removeCard('${child.key}')">Xóa</button></td>`;
      tbody.appendChild(tr);
    });
  }, onErr);

  // Danh sách tài khoản: chỉ hiện các role đã gán trong /roles (Firebase client SDK
  // không liệt kê được toàn bộ user — tạo/xóa tài khoản làm qua Firebase Console)
  const rolesRef = db.ref("roles");
  rolesRef.on("value", snap => {
    const tbody = document.querySelector("#userTable tbody");
    tbody.innerHTML = "";
    snap.forEach(child => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(child.key)}</td><td>${escapeHtml(child.val())}</td>`;
      tbody.appendChild(tr);
    });
  }, onErr);

  // PIN hiện tại: tự cập nhật mỗi khi đổi
  const pinRef = db.ref("config/masterPin");
  pinRef.on("value", snap => {
    currentPinValue = snap.exists() ? String(snap.val()) : null;
    renderPin();
  }, onErr);

  // Thẻ vừa được quét trên đầu đọc (ESP32 ghi vào config/lastScan)
  const scanRef = db.ref("config/lastScan");
  scanRef.on("value", snap => {
    lastScanData = snap.val();
    handleScan();
  }, onErr);

  adminRefs = [cardsRef, rolesRef, pinRef, scanRef];
}

function detachAdminListeners() {
  if (!adminRefs.length) return;
  adminRefs.forEach(r => r.off());
  adminRefs = [];
  cancelRegister("");
  cardsCache = {};
  currentPinValue = null;
  document.querySelector("#cardTable tbody").innerHTML = "";
  document.querySelector("#userTable tbody").innerHTML = "";
  renderPin();
}

// ---------- Hiển thị PIN hiện tại ----------
function renderPin() {
  const el = document.getElementById("currentPin");
  const tg = document.getElementById("pinToggle");
  if (currentPinValue === null) {
    el.innerText = "--";
    tg.classList.add("hidden");
    return;
  }
  tg.classList.remove("hidden");
  el.innerText = pinVisible ? currentPinValue : "\u2022".repeat(currentPinValue.length);
  tg.innerText = pinVisible ? "Ẩn" : "Hiện";
}

function togglePinVisible() {
  pinVisible = !pinVisible;
  renderPin();
}

// ---------- Đăng ký thẻ: quét thẻ -> UID tự hiện ----------
function toggleRegister() {
  if (currentRole !== "admin") return;
  if (registering) { cancelRegister("Đã hủy đăng ký thẻ."); return; }

  registering = true;
  scanBaseline = JSON.stringify(lastScanData);       // mốc: chỉ tính các lần quét SAU lúc bấm
  db.ref("config/registerMode").set(true);           // báo ESP32: thẻ lạ sắp quét là để đăng ký, đừng báo động
  document.getElementById("regBtn").innerText = "Hủy đăng ký thẻ";
  document.getElementById("scanStatus").innerText =
    "Đang chờ quét thẻ... hãy đặt thẻ lên đầu đọc RFID (tối đa 60 giây).";
  registerTimer = setTimeout(() => cancelRegister("Hết thời gian chờ. Bấm lại để thử lần nữa."), 60000);
}

function endRegister() {
  registering = false;
  clearTimeout(registerTimer);
  registerTimer = null;
  const btn = document.getElementById("regBtn");
  if (btn) btn.innerText = "Quét thẻ để đăng ký";
  if (currentRole === "admin") db.ref("config/registerMode").set(false);
}

function cancelRegister(msg) {
  if (registering) endRegister();
  const st = document.getElementById("scanStatus");
  if (st && msg) st.innerText = msg;
}

function handleScan() {
  if (!registering || !lastScanData) return;
  if (JSON.stringify(lastScanData) === scanBaseline) return;   // chưa có lần quét mới

  const uid = String(lastScanData.uid || "").toUpperCase();
  const st = document.getElementById("scanStatus");

  if (lastScanData.registered) {
    const owner = cardsCache[uid];
    st.innerText = "Thẻ " + uid + " đã được đăng ký" + (owner ? " (chủ thẻ: " + owner + ")" : "") +
                   ". Hãy quét thẻ khác.";
    scanBaseline = JSON.stringify(lastScanData);               // tiếp tục chờ thẻ khác
    return;
  }

  document.getElementById("newCardUid").value = uid;
  st.innerText = "Đã nhận thẻ mới: " + uid + " — nhập tên chủ thẻ rồi bấm \"Thêm thẻ\".";
  endRegister();
  document.getElementById("newCardOwner").focus();
}

function addCard() {
  if (currentRole !== "admin") { alert("Chỉ Admin được thêm thẻ"); return; }
  const uid = document.getElementById("newCardUid").value.trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
  const owner = document.getElementById("newCardOwner").value.trim();
  if (!uid) { alert("Nhập UID thẻ (hoặc bấm \"Quét thẻ để đăng ký\")"); return; }
  if (uid in cardsCache) { alert("Thẻ " + uid + " đã được đăng ký rồi."); return; }

  // Chỉ ghi dữ liệu; log xác nhận do ESP32 ghi sau khi nó đồng bộ xong
  db.ref("cards").push({ uid, owner });
  document.getElementById("newCardUid").value = "";
  document.getElementById("newCardOwner").value = "";
}

function removeCard(key) {
  if (currentRole !== "admin") return;
  db.ref("cards/" + key).remove();
}

function changePin() {
  if (currentRole !== "admin") { alert("Chỉ Admin được đổi PIN"); return; }
  const pin = document.getElementById("newPin").value.trim();
  // Thiết bị chỉ nhận mật khẩu đúng 4 chữ số (nhập đủ 4 số trên keypad là tự mở)
  if (!/^[0-9]{4}$/.test(pin)) { alert("PIN phải gồm đúng 4 chữ số"); return; }

  // pin là chuỗi (giữ nguyên số 0 đứng đầu); ESP32 nhận qua stream rồi tự ghi log xác nhận
  db.ref("config/masterPin").set(String(pin));
  document.getElementById("newPin").value = "";
  // Ô "Mã PIN hiện tại" ở trên tự cập nhật ngay; tab Logs sẽ có dòng xác nhận khi ESP32 đã áp dụng
}

// ================= TAB LOGS =================
let allLogs = [];

db.ref("logs").limitToLast(50).on("value", snap => {
  allLogs = [];
  // LƯU Ý: phải dùng dấu { } và KHÔNG return gì cả. Nếu viết gọn
  // child => allLogs.push(...) thì hàm trả về số (độ dài mảng, luôn là số dương
  // = "true"), Firebase hiểu là "dừng duyệt" và chỉ lấy được đúng 1 log đầu tiên.
  snap.forEach(child => {
    allLogs.push(child.val());
  });
  allLogs.reverse(); // mới nhất lên đầu
  renderLogs();

  // Đếm số cảnh báo (sự kiện thất bại) trong 24 giờ gần nhất cho dải tổng quan
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const alertCount = allLogs.filter(e =>
    e.time && e.time >= dayAgo && (e.result || "").toLowerCase().includes("that bai")
  ).length;
  const alertEl = document.getElementById("statAlerts");
  if (alertEl) {
    alertEl.innerText = alertCount;
    alertEl.style.color = alertCount > 0 ? "var(--bad)" : "var(--ok)";
  }
});

document.getElementById("logFilter").addEventListener("change", renderLogs);

function clearLogs() {
  if (currentRole !== "admin") return;
  if (!confirm("Xóa toàn bộ lịch sử ra vào? Hành động này không thể hoàn tác.")) return;
  db.ref("logs").remove()
    .then(() => console.log("Đã xóa toàn bộ log"))
    .catch(err => alert("Không xóa được log: " + err.message));
}

function renderLogs() {
  const filter = document.getElementById("logFilter").value;
  const tbody = document.querySelector("#logTable tbody");
  tbody.innerHTML = "";

  allLogs.forEach(e => {
    const isSuccess = (e.result || "").toLowerCase().includes("thanh cong");
    if (filter === "success" && !isSuccess) return;
    if (filter === "fail" && isSuccess) return;

    const tr = document.createElement("tr");
    const timeStr = e.time ? new Date(e.time).toLocaleString("vi-VN") : "--";
    tr.innerHTML = `<td>${timeStr}</td><td>${e.method || ""}</td>
      <td class="${isSuccess ? "tag-success" : "tag-fail"}">${e.result || ""}</td>`;
    tbody.appendChild(tr);
  });
}