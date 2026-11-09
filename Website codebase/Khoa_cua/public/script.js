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

// ---- Trạng thái dùng chung ----
let doorLockedState = true;
let prevLocked = null;        
let autoLockSec = 5;          
let unlockSeenAt = null;      
let statusData = {};          
let serverOffset = 0;         

let protectedRefs = [];       // Lưu trữ các luồng lắng nghe dữ liệu cần bảo vệ (của admin/user)
let cardsCache = {};          
let currentPinValue = null;
let pinVisible = true;
let lastScanData = null;
let registering = false;
let scanBaseline = null;
let registerTimer = null;
let allLogs = [];             // Biến lưu trữ logs

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
    // Ngăn chặn guest bấm vào tab Logs
    if (currentRole === "guest" && item.dataset.tab === "logs") {
      return; 
    }

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

// BẮT SỰ KIỆN NHẤN ENTER ĐỂ ĐĂNG NHẬP
document.getElementById("loginEmail").addEventListener("keypress", function(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    document.getElementById("loginPassword").focus(); // Chuyển con trỏ xuống ô Mật khẩu
  }
});

document.getElementById("loginPassword").addEventListener("keypress", function(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    doLogin(); // Gọi hàm đăng nhập
  }
});

// Theo dõi trạng thái đăng nhập
auth.onAuthStateChanged(user => {
  currentUser = user;
  if (user) {
    db.ref("roles/" + user.uid).once("value").then(snap => {
      currentRole = snap.exists() ? snap.val() : "user"; 
      applyRoleToUI(user.email);
    }).catch(err => {
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
  const menuLogs = document.getElementById("menuLogs"); // Liên kết với ID menuLogs bên HTML

  if (currentRole === "guest") {
    loginLink.classList.remove("hidden");
    userInfo.classList.add("hidden");
    menuUser.classList.add("hidden");
    if (menuLogs) menuLogs.classList.add("hidden"); // Ẩn tab Logs nếu chưa đăng nhập
  } else {
    loginLink.classList.add("hidden");
    userInfo.classList.remove("hidden");
    userInfo.innerHTML = email + " (" + currentRole + ") | " +
      '<a href="#" onclick="doLogout();return false;">Đăng xuất</a>';
    menuUser.classList.toggle("hidden", currentRole !== "admin");
    if (menuLogs) menuLogs.classList.remove("hidden"); // Hiện tab Logs nếu đã đăng nhập
  }
  
  renderDoorUI();

  const clearBtn = document.getElementById("clearLogsBtn");
  if (clearBtn) clearBtn.classList.toggle("hidden", currentRole !== "admin");

  // Xử lý gắn/gỡ các listener dữ liệu bảo mật
  if (currentRole === "admin" || currentRole === "user") {
    attachProtectedListeners();
  } else {
    detachProtectedListeners();
  }

  // Điều hướng tự động nếu User/Guest đang ở tab không có quyền truy cập
  const inUserTab = document.getElementById("tab-user").classList.contains("active");
  const inLogsTab = document.getElementById("tab-logs").classList.contains("active");

  if ((currentRole !== "admin" && inUserTab) || (currentRole === "guest" && inLogsTab)) {
    document.querySelector('.menu-item[data-tab="system"]').click();
  }
}

// ================= TAB SYSTEM: TRẠNG THÁI CỬA + THIẾT BỊ =================
db.ref(".info/serverTimeOffset").on("value", snap => { serverOffset = Number(snap.val()) || 0; });
function serverNow() { return Date.now() + serverOffset; }

const HEARTBEAT_STALE_MS = 25000;

function isDeviceOnline() {
  const lu = Number(statusData.lastUpdate) || 0;
  if (!lu) return null;
  return (serverNow() - lu) < HEARTBEAT_STALE_MS;
}

function renderConnection() {
  const connEl = document.getElementById("statConnection");
  const lastEl = document.getElementById("statLastUpdate");
  const online = isDeviceOnline();
  const dev = (online === false) ? {} : (statusData.devices || {});

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

function renderDoorUI() {
  const locked = statusData.doorLocked !== false;
  const icon = document.getElementById("doorIcon");
  const btn = document.getElementById("doorBtn");
  const hint = document.getElementById("doorHint");
  const guest = (currentRole === "guest");

  document.getElementById("doorStatusText").innerText = locked ? "Đang khóa" : "Đang mở";
  icon.innerHTML = locked ? "&#128274;" : "&#128275;"; 
  icon.classList.toggle("unlocked", !locked);

  if (locked) {
    const reqAt = Number(statusData.openRequest) || 0;          
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

  btn.disabled = true;
  hint.innerText = "Cửa tự động khóa lại";
  let remain = null;
  const at = Number(statusData.autoLockAt);
  if (at > 1.6e12) {
    remain = Math.ceil((at - serverNow()) / 1000);             
  } else if (unlockSeenAt !== null) {
    remain = Math.ceil(autoLockSec - (Date.now() - unlockSeenAt) / 1000);  
  }
  if (remain === null) btn.innerText = "Cửa sắp tự khóa";
  else if (remain > 0) btn.innerText = "Tự khóa sau " + remain + " giây";
  else if (remain > -6) btn.innerText = "Đang khóa lại...";
  else {
    btn.innerText = "Chưa thấy thiết bị khóa lại";
    hint.innerText = "Kiểm tra kết nối ESP32 (xem ô Kết nối thiết bị)";
  }
}
setInterval(renderDoorUI, 500);   

db.ref("status").on("value", snap => {
  const data = snap.val() || {};
  statusData = data;
  const locked = data.doorLocked !== false; 
  if (data.autoLockSec) autoLockSec = Number(data.autoLockSec) || 5;

  if (locked) unlockSeenAt = null;
  else if (prevLocked === true) unlockSeenAt = Date.now();   
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

document.getElementById("doorBtn").addEventListener("click", () => {
  if (currentRole === "guest" || statusData.doorLocked === false) return;
  const reqAt = Number(statusData.openRequest) || 0;
  if (reqAt && (serverNow() - reqAt) / 1000 < 15) return;     
  db.ref("status/openRequest").set(firebase.database.ServerValue.TIMESTAMP);
});


// ================= DỮ LIỆU ĐƯỢC BẢO VỆ (CHỈ KHI LOGGED IN MỚI TẢI) =================
function escapeHtml(t) {
  return String(t == null ? "" : t).replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function attachProtectedListeners() {
  if (protectedRefs.length) return;
  const onErr = err => console.error("Lỗi đọc dữ liệu bảo mật:", err.message);

  // 1. CHỈ ADMIN MỚI TẢI DATA THẺ & TÀI KHOẢN
  if (currentRole === "admin") {
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
    protectedRefs.push(cardsRef);

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
    protectedRefs.push(rolesRef);

    const pinRef = db.ref("config/masterPin");
    pinRef.on("value", snap => {
      currentPinValue = snap.exists() ? String(snap.val()) : null;
      renderPin();
    }, onErr);
    protectedRefs.push(pinRef);

    const scanRef = db.ref("config/lastScan");
    scanRef.on("value", snap => {
      lastScanData = snap.val();
      handleScan();
    }, onErr);
    protectedRefs.push(scanRef);
  }

  // 2. TẢI LOGS (Dành cho Admin và User, GUEST KHÔNG ĐƯỢC TẢI)
  const logsRef = db.ref("logs").limitToLast(50);
  logsRef.on("value", snap => {
    allLogs = [];
    snap.forEach(child => {
      allLogs.push(child.val());
    });
    allLogs.reverse(); 
    renderLogs();

    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const alertCount = allLogs.filter(e =>
      e.time && e.time >= dayAgo && (e.result || "").toLowerCase().includes("that bai")
    ).length;
    const alertEl = document.getElementById("statAlerts");
    if (alertEl) {
      alertEl.innerText = alertCount;
      alertEl.style.color = alertCount > 0 ? "var(--bad)" : "var(--ok)";
    }
  }, onErr);
  protectedRefs.push(logsRef);
}

function detachProtectedListeners() {
  if (!protectedRefs.length) return;
  protectedRefs.forEach(r => r.off());
  protectedRefs = [];
  cancelRegister("");
  cardsCache = {};
  currentPinValue = null;
  document.querySelector("#cardTable tbody").innerHTML = "";
  document.querySelector("#userTable tbody").innerHTML = "";
  document.querySelector("#logTable tbody").innerHTML = ""; // Xóa sạch dữ liệu bảng log
  allLogs = []; // Xóa mảng lưu log
  renderPin();
  
  const alertEl = document.getElementById("statAlerts");
  if(alertEl) {
      alertEl.innerText = "--";
      alertEl.style.color = "";
  }
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
  scanBaseline = JSON.stringify(lastScanData);       
  db.ref("config/registerMode").set(true);           
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
  if (JSON.stringify(lastScanData) === scanBaseline) return;   

  const uid = String(lastScanData.uid || "").toUpperCase();
  const st = document.getElementById("scanStatus");

  if (lastScanData.registered) {
    const owner = cardsCache[uid];
    st.innerText = "Thẻ " + uid + " đã được đăng ký" + (owner ? " (chủ thẻ: " + owner + ")" : "") +
                   ". Hãy quét thẻ khác.";
    scanBaseline = JSON.stringify(lastScanData);               
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
  if (!/^[0-9]{4}$/.test(pin)) { alert("PIN phải gồm đúng 4 chữ số"); return; }

  db.ref("config/masterPin").set(String(pin));
  document.getElementById("newPin").value = "";
}

// ================= TAB LOGS =================
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