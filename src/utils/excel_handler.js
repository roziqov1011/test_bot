const ExcelJS = require('exceljs');
const fs = require('fs');

async function parseQuestions(filePath) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = workbook.getWorksheet(1);
    const questions = [];

    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) {
            // Header validation
            const hasRequiredColumns = 
                row.getCell(1).text && 
                row.getCell(2).text && 
                row.getCell(3).text && 
                row.getCell(7).text;
            
            if (!hasRequiredColumns) {
                throw new Error('Excel fayl formati noto\'g\'ri. Ustunlar yetishmayapti.');
            }
            return;
        }

        const category = row.getCell(1).text;
        const text = row.getCell(2).text;
        const options = [
            row.getCell(3).text,
            row.getCell(4).text,
            row.getCell(5).text,
            row.getCell(6).text
        ];
        const correctAnswer = row.getCell(7).text;

        if (category && text && correctAnswer) {
            questions.push({
                category,
                text,
                options: JSON.stringify(options),
                correctAnswer
            });
        }
    });

    return questions;
}

async function exportResults(results) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Results');

    worksheet.columns = [
        { header: 'ID', key: 'id', width: 10 },
        { header: 'Foydalanuvchi', key: 'name', width: 30 },
        { header: 'Username', key: 'username', width: 20 },
        { header: 'Ball', key: 'score', width: 10 },
        { header: 'Jami savollar', key: 'total', width: 15 },
        { header: 'Sarflandgan vaqt (sekund)', key: 'time', width: 20 },
        { header: 'Sana', key: 'date', width: 25 }
    ];

    results.forEach(res => {
        worksheet.addRow({
            id: res.id,
            name: res.user.firstName || 'No name',
            username: res.user.username ? `@${res.user.username}` : '-',
            score: res.score,
            total: res.totalQuestions,
            time: res.spentTime,
            date: res.createdAt.toLocaleString('uz-UZ')
        });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
}

module.exports = {
    parseQuestions,
    exportResults
};