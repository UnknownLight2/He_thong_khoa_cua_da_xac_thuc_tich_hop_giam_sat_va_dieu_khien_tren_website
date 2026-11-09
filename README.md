# Hệ thống khóa cửa đa xác thực, tích hợp giám sát và điều khiển trên website

Đây là hệ thống khóa cửa thông minh dùng ESP32. Người dùng có thể mở khóa tại cửa bằng thẻ RFID đã đăng ký hoặc mã PIN 4 chữ số. Cửa tự khóa lại sau khi mở.

Website quản lý cho phép theo dõi trạng thái khóa và tình trạng kết nối của thiết bị. Sau khi đăng nhập, người quản trị có thể mở khóa từ xa, thêm hoặc xóa thẻ RFID, đổi mã PIN và xem lịch sử ra vào.

PS: Nếu muốn dùng codebase của trang web thì hãy thay đổi Firebase-config.js thành APIKEY của tài khoản Firebase bạn dùng. Đồng thời thay đổi rules của Realtime data bên Firebase theo sau, vì nhóm mình quên add này thành một file để có thể copy dùng:

{
  "rules": {
    "status": {
      ".read": true,
      "doorLocked": {
        ".write": "auth != null && root.child('roles').child(auth.uid).val() === 'admin'"
      },
      "autoLockAt": {
        ".write": "auth != null && root.child('roles').child(auth.uid).val() === 'admin'"
      },
      "autoLockSec": {
        ".write": "auth != null && root.child('roles').child(auth.uid).val() === 'admin'"
      },
      "devices": {
        ".write": "auth != null && root.child('roles').child(auth.uid).val() === 'admin'"
      },
      "lastUpdate": {
        ".write": "auth != null && root.child('roles').child(auth.uid).val() === 'admin'"
      },
      "openRequest": {
        ".write": "auth != null",
        ".validate": "!newData.exists() || newData.isNumber()"
      }
    },
    "cards": {
      ".read": "auth != null && root.child('roles').child(auth.uid).val() === 'admin'",
      ".write": "auth != null && root.child('roles').child(auth.uid).val() === 'admin'"
    },
    "config": {
      ".read": "auth != null && root.child('roles').child(auth.uid).val() === 'admin'",
      ".write": "auth != null && root.child('roles').child(auth.uid).val() === 'admin'"
    },
    "logs": {
      ".read": true,
      ".write": "auth != null && root.child('roles').child(auth.uid).val() === 'admin'"
    },
    "roles": {
      ".read": "auth != null && root.child('roles').child(auth.uid).val() === 'admin'",
      ".write": false,
      "$uid": {
        ".read": "auth != null && auth.uid === $uid"
      }
    }
  }
}

Khi tạo tài khoản đăng nhập web, hãy nhớ copy id của tài khoản sau khi tạo vào **KEY** và nhập vào **VALUE** ("admin"/"user") để nhập vai trò vào tài khoản ấy
