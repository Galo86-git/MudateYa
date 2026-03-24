// api/admin-data.js
// Lee datos de Google Sheets para el panel de admin

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  var type = req.query.type; // 'mudanceros' | 'pagos'

  if (!type) {
    return res.status(400).json({ error: 'Falta parámetro type' });
  }

  var sheetUrl = type === 'mudanceros'
    ? process.env.GOOGLE_SHEETS_WEBHOOK_URL
    : process.env.GOOGLE_SHEETS_PAGOS_URL;

  if (!sheetUrl) {
    return res.status(200).json({ rows: [] });
  }

  try {
    // Leer datos del Google Sheet vía Apps Script
    var readUrl = sheetUrl.replace('/exec', '/exec') + '?action=read&sheet=' + type;
    var response = await fetch(readUrl);
    var data = await response.json();

    return res.status(200).json({
      rows: data.rows || [],
      total: data.total || 0,
    });
  } catch (error) {
    console.error('Error leyendo Sheets:', error);
    return res.status(200).json({ rows: [], error: error.message });
  }
};
