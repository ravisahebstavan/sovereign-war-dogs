var SHEET_ID = "1QuFViqHJDTFWi5GVigb2KGnhFp-_3rW2mVkL0peqo30";
var SHEET_NAME = "Logs";

function doGet(e) {
  try {
    var ss    = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_NAME);

    // Write headers if sheet is empty
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["Timestamp", "Session ID", "Version", "OS", "Country", "City", "IP"]);
      sheet.getRange(1, 1, 1, 7).setFontWeight("bold").setBackground("#1a1a2e").setFontColor("#00ffe0");
      sheet.setFrozenRows(1);
    }

    // Log the visit
    var ip      = e && e.parameter ? (e.parameter.ip  || "unknown") : "unknown";
    var sid     = e && e.parameter ? (e.parameter.sid || "unknown") : "unknown";
    var version = e && e.parameter ? (e.parameter.v   || "unknown") : "unknown";
    var os      = e && e.parameter ? (e.parameter.os  || "unknown") : "unknown";

    // Geo lookup via ip-api (free, no key needed)
    var country = "unknown";
    var city    = "unknown";
    try {
      var geo  = UrlFetchApp.fetch("http://ip-api.com/json/" + ip + "?fields=country,city", {muteHttpExceptions: true});
      var data = JSON.parse(geo.getContentText());
      country  = data.country || "unknown";
      city     = data.city    || "unknown";
    } catch(geoErr) {}

    sheet.appendRow([
      new Date().toISOString(),
      sid,
      version,
      os,
      country,
      city,
      ip
    ]);

    return ContentService.createTextOutput("ok");
  } catch(err) {
    return ContentService.createTextOutput("error: " + err.toString());
  }
}
