// api/mudancero-data.js
// Busca un mudancero por email en Google Sheets

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  var email = req.query.email;
  if (!email) {
    return res.status(400).json({ error: 'Falta email' });
  }

  var sheetUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!sheetUrl) {
    return res.status(200).json({ found: false });
  }

  try {
    var response = await fetch(sheetUrl + '?action=find&email=' + encodeURIComponent(email));
    var data = await response.json();

    if (data.rows && data.rows.length > 0) {
      // Buscar fila que coincida con el email (columna 5, índice 4)
      var mudancero = data.rows.find(function(row) {
        return (row[4] || '').toLowerCase().trim() === email.toLowerCase().trim();
      });

      if (mudancero) {
        return res.status(200).json({ found: true, mudancero });
      }
    }

    return res.status(200).json({ found: false });
  } catch (error) {
    console.error('Error buscando mudancero:', error);
    // En caso de error devolver not found
    return res.status(200).json({ found: false, error: error.message });
  }
};
