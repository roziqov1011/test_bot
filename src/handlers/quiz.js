const { InlineKeyboard, InputFile } = require('grammy');
const prisma = require('../db');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const QUESTION_TIME_LIMIT = process.env.QUESTION_TIME_LIMIT ? parseInt(process.env.QUESTION_TIME_LIMIT) * 1000 : 30 * 1000; // 30 seconds
const QUIZ_TIME_LIMIT = process.env.QUIZ_TIME_LIMIT ? parseInt(process.env.QUIZ_TIME_LIMIT) * 60 * 1000 : 20 * 60 * 1000; // 20 minutes

function shuffleArray(array) {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
}

// Active timers in-memory cache
const activeTimers = new Map();

function clearUserTimers(userId) {
    const timers = activeTimers.get(userId);
    if (timers) {
        if (timers.questionTimer) clearTimeout(timers.questionTimer);
        if (timers.quizTimer) clearTimeout(timers.quizTimer);
        activeTimers.delete(userId);
    }
}

async function getSession(userId) {
    const key = userId.toString();
    const sessionRecord = await prisma.session.findUnique({
        where: { key }
    });
    if (sessionRecord) {
        return JSON.parse(sessionRecord.value);
    }
    return null;
}

async function saveSession(userId, sessionData) {
    const key = userId.toString();
    await prisma.session.upsert({
        where: { key },
        update: { value: JSON.stringify(sessionData) },
        create: { key, value: JSON.stringify(sessionData) }
    });
}

function createDummyCtx(originalCtx, sessionData, userId) {
    return {
        api: originalCtx.api,
        session: sessionData,
        dbUser: originalCtx.dbUser,
        from: {
            id: userId,
            first_name: originalCtx.dbUser ? originalCtx.dbUser.firstName : 'Foydalanuvchi'
        },
        chat: {
            id: userId
        },
        callbackQuery: null,
        reply: async (text, options) => {
            return await originalCtx.api.sendMessage(userId, text, options);
        },
        replyWithPhoto: async (photo, options) => {
            return await originalCtx.api.sendPhoto(userId, photo, options);
        },
        replyWithDocument: async (doc, options) => {
            return await originalCtx.api.sendDocument(userId, doc, options);
        },
        editMessageText: async (text, options) => {
            if (sessionData.quiz && sessionData.quiz.questionMessageId) {
                return await originalCtx.api.editMessageText(userId, sessionData.quiz.questionMessageId, text, options).catch(() => {
                    return originalCtx.api.sendMessage(userId, text, options);
                });
            }
            return await originalCtx.api.sendMessage(userId, text, options);
        },
        deleteMessage: async () => {
            if (sessionData.quiz && sessionData.quiz.questionMessageId) {
                return await originalCtx.api.deleteMessage(userId, sessionData.quiz.questionMessageId).catch(() => {});
            }
        }
    };
}

async function handleQuestionTimeout(userId, ctx) {
    const sessionData = await getSession(userId);
    if (!sessionData || sessionData.step !== 'quiz' || !sessionData.quiz) {
        clearUserTimers(userId);
        return;
    }

    const quiz = sessionData.quiz;
    const question = quiz.questions[quiz.currentIndex];

    // Remove keyboard and show "Vaqt tugadi"
    if (quiz.questionMessageId) {
        const options = JSON.parse(question.options);
        let optionsText = "";
        options.forEach((opt, index) => {
            const optionLetter = String.fromCharCode(65 + index);
            optionsText += `\n${optionLetter}) ${opt}`;
        });
        const timePassed = Date.now() - quiz.startTime;
        const timeLeft = Math.max(0, quiz.timeLimit - timePassed);
        const minutes = Math.floor(timeLeft / 60000);
        const seconds = Math.floor((timeLeft % 60000) / 1000);
        const progress = `${quiz.currentIndex + 1}/${quiz.questions.length}`;
        const text = `📊 Savol ${progress}\n\n${question.text}\n${optionsText}\n\n⏱ Har bir savol uchun vaqt: ${quiz.questionTimeLimit / 1000} soniya\n⏳ Test tugashiga: ${minutes}:${seconds.toString().padStart(2, '0')}`;
        const updatedText = text + `\n\n⚠️ <b>Vaqt tugadi! Ushbu savolga belgilangan vaqt ichida javob berilmadi.</b>`;

        if (question.imageFileId) {
            await ctx.api.editMessageCaption(userId, quiz.questionMessageId, {
                caption: updatedText,
                parse_mode: 'HTML',
                reply_markup: new InlineKeyboard()
            }).catch(() => {});
        } else {
            await ctx.api.editMessageText(userId, quiz.questionMessageId, updatedText, {
                parse_mode: 'HTML',
                reply_markup: new InlineKeyboard()
            }).catch(() => {});
        }
    }

    // Record timeout answer
    quiz.userAnswers.push({
        questionNumber: quiz.currentIndex + 1,
        questionText: question.text,
        userAnswer: "Javob berilmagan (Vaqt o'tgan)",
        correctAnswer: question.correctAnswer,
        isCorrect: false
    });

    quiz.currentIndex++;

    const timePassed = Date.now() - quiz.startTime;
    const dummyCtx = createDummyCtx(ctx, sessionData, userId);

    if (timePassed >= quiz.timeLimit || quiz.currentIndex >= quiz.questions.length) {
        await finishQuiz(dummyCtx);
        await saveSession(userId, dummyCtx.session);
    } else {
        await sendQuestion(dummyCtx);
        await saveSession(userId, dummyCtx.session);
    }
}

async function handleQuizTimeout(userId, ctx) {
    const sessionData = await getSession(userId);
    if (!sessionData || sessionData.step !== 'quiz' || !sessionData.quiz) {
        clearUserTimers(userId);
        return;
    }

    await ctx.api.sendMessage(userId, "⏳ <b>Kechirasiz, test uchun ajratilgan umumiy vaqt tugadi!</b>", { parse_mode: 'HTML' }).catch(() => {});

    clearUserTimers(userId);

    const dummyCtx = createDummyCtx(ctx, sessionData, userId);
    await finishQuiz(dummyCtx);
    await saveSession(userId, dummyCtx.session);
}


async function showCategories(ctx) {
    const categories = await prisma.category.findMany({
        include: { _count: { select: { questions: true } } }
    });

    if (categories.length === 0) {
        return ctx.reply('Hozircha hech qanday test mavjud emas.');
    }

    const keyboard = new InlineKeyboard();
    categories.forEach(cat => {
        keyboard.text(`${cat.name} (${cat._count.questions})`, `select_cat_${cat.id}`).row();
    });

    await ctx.editMessageText('Iltimos, test topshirmoqchi bo\'lgan kategoriyangizni tanlang:', {
        reply_markup: keyboard
    });
}

async function startQuiz(ctx, categoryId) {
    const questions = await prisma.question.findMany({
        where: { categoryId: parseInt(categoryId) }
    });

    if (questions.length === 0) {
        return ctx.answerCallbackQuery('Bu kategoriyada savollar yo\'q.');
    }

    const maxQSetting = await prisma.setting.findUnique({ where: { key: 'maxQuestions' } });
    const maxQLimit = maxQSetting ? parseInt(maxQSetting.value) : (process.env.MAX_QUESTIONS ? parseInt(process.env.MAX_QUESTIONS) : 30);

    // Savollarni aralashtirish va belgilangan maksimal miqdorni olish
    const shuffledQuestions = shuffleArray(questions).slice(0, maxQLimit);
    
    // Har bir savolning variantlarini ham alohida-alohida aralashtirish
    const questionsWithShuffledOptions = shuffledQuestions.map(q => {
        const options = JSON.parse(q.options);
        const shuffledOptions = shuffleArray(options);
        return {
            ...q,
            options: JSON.stringify(shuffledOptions)
        };
    });

    const questionTimeSetting = await prisma.setting.findUnique({ where: { key: 'questionTime' } });
    const questionTimeLimit = questionTimeSetting ? parseInt(questionTimeSetting.value) * 1000 : QUESTION_TIME_LIMIT;
    const quizTimeLimit = questionsWithShuffledOptions.length * questionTimeLimit;

    const userId = ctx.from.id;
    clearUserTimers(userId);

    ctx.session.quiz = {
        categoryId: parseInt(categoryId),
        questions: questionsWithShuffledOptions,
        currentIndex: 0,
        score: 0,
        startTime: Date.now(),
        timeLimit: quizTimeLimit,
        questionTimeLimit: questionTimeLimit,
        userAnswers: []
    };
    ctx.session.step = 'quiz';

    // Set overall quiz timer
    const quizTimer = setTimeout(async () => {
        await handleQuizTimeout(userId, ctx);
    }, quizTimeLimit);
    activeTimers.set(userId, { quizTimer, questionTimer: null });

    await sendQuestion(ctx);
}

async function sendQuestion(ctx) {
    const quiz = ctx.session.quiz;
    const question = quiz.questions[quiz.currentIndex];
    const options = JSON.parse(question.options);

    const keyboard = new InlineKeyboard();
    let optionsText = "";
    options.forEach((opt, index) => {
        const optionLetter = String.fromCharCode(65 + index); // A, B, C, D...
        optionsText += `\n${optionLetter}) ${opt}`;
        keyboard.text(optionLetter, `answer_${index}`);
    });

    const timePassed = Date.now() - quiz.startTime;
    const timeLeft = Math.max(0, quiz.timeLimit - timePassed);
    const minutes = Math.floor(timeLeft / 60000);
    const seconds = Math.floor((timeLeft % 60000) / 1000);

    // Savol yuborilish vaqtini saqlash
    quiz.questionStartTime = Date.now();

    const progress = `${quiz.currentIndex + 1}/${quiz.questions.length}`;
    const text = `📊 Savol ${progress}\n\n${question.text}\n${optionsText}\n\n⏱ Har bir savol uchun vaqt: ${quiz.questionTimeLimit / 1000} soniya\n⏳ Test tugashiga: ${minutes}:${seconds.toString().padStart(2, '0')}`;

    let sentMessage;
    if (question.imageFileId) {
        if (ctx.callbackQuery) {
            await ctx.deleteMessage().catch(() => {});
        }
        sentMessage = await ctx.replyWithPhoto(question.imageFileId, { caption: text, reply_markup: keyboard });
    } else {
        if (ctx.callbackQuery) {
            try {
                sentMessage = await ctx.editMessageText(text, { reply_markup: keyboard });
            } catch (e) {
                await ctx.deleteMessage().catch(() => {});
                sentMessage = await ctx.reply(text, { reply_markup: keyboard });
            }
        } else {
            sentMessage = await ctx.reply(text, { reply_markup: keyboard });
        }
    }

    if (sentMessage) {
        quiz.questionMessageId = sentMessage.message_id;
    }

    const userId = ctx.from.id;
    const timers = activeTimers.get(userId) || {};
    if (timers.questionTimer) clearTimeout(timers.questionTimer);

    timers.questionTimer = setTimeout(async () => {
        await handleQuestionTimeout(userId, ctx);
    }, quiz.questionTimeLimit);

    activeTimers.set(userId, timers);
}

async function handleAnswer(ctx, answerIndex) {
    const quiz = ctx.session.quiz;
    if (!quiz || ctx.session.step !== 'quiz') return;

    // Clear question timer
    const userId = ctx.from.id;
    const timers = activeTimers.get(userId);
    if (timers && timers.questionTimer) {
        clearTimeout(timers.questionTimer);
        timers.questionTimer = null;
    }

    // Race condition prevention (check if click corresponds to the active question message)
    if (ctx.callbackQuery && ctx.callbackQuery.message && quiz.questionMessageId) {
        if (ctx.callbackQuery.message.message_id !== quiz.questionMessageId) {
            await ctx.answerCallbackQuery({
                text: "⏳ Vaqt o'tgan yoki eski savolga javob berib bo'lmaydi!",
                show_alert: true
            }).catch(() => {});
            return;
        }
    }

    const question = quiz.questions[quiz.currentIndex];
    const options = JSON.parse(question.options);
    const selectedAnswer = options[answerIndex];

    const questionTimePassed = Date.now() - (quiz.questionStartTime || Date.now());
    let answeredLate = false;

    if (questionTimePassed > quiz.questionTimeLimit) {
        answeredLate = true;
        try {
            await ctx.answerCallbackQuery({
                text: `⏳ Vaqt tugadi! Siz bu savolga belgilangan ${quiz.questionTimeLimit / 1000} soniyadan kech qoldingiz.`,
                show_alert: true
            });
        } catch(e) {}
    } else {
        await ctx.answerCallbackQuery().catch(() => {});
    }

    const isCorrect = selectedAnswer === question.correctAnswer;

    quiz.userAnswers.push({
        questionNumber: quiz.currentIndex + 1,
        questionText: question.text,
        userAnswer: answeredLate ? "Javob berilmagan (Vaqt o'tgan)" : selectedAnswer,
        correctAnswer: question.correctAnswer,
        isCorrect: !answeredLate && isCorrect
    });

    if (!answeredLate && isCorrect) {
        quiz.score++;
    }

    quiz.currentIndex++;

    // Vaqtni tekshirish
    const timePassed = Date.now() - quiz.startTime;
    if (timePassed >= quiz.timeLimit || quiz.currentIndex >= quiz.questions.length) {
        await finishQuiz(ctx);
    } else {
        await sendQuestion(ctx);
    }
}

async function finishQuiz(ctx) {
    // Clear all active timers
    clearUserTimers(ctx.from.id);

    const quiz = ctx.session.quiz;
    const spentTime = Math.floor((Date.now() - quiz.startTime) / 1000);
    
    // Natijani bazaga saqlash
    const result = await prisma.result.create({
        data: {
            userId: ctx.dbUser.id,
            score: quiz.score,
            totalQuestions: quiz.questions.length,
            spentTime: spentTime
        }
    });

    const accuracy = ((quiz.score / quiz.questions.length) * 100).toFixed(1);
    const text = `🏁 Test yakunlandi!\n\n✅ To'g'ri javoblar: ${quiz.score}\n❌ Xato javoblar: ${quiz.questions.length - quiz.score}\n🎯 Aniqlik: ${accuracy}%\n⏱ Sarflangan vaqt: ${spentTime} sekund`;

    const keyboard = new InlineKeyboard()
        .text('🔄 Qayta urinish', 'start_quiz')
        .row()
        .switchInline('🚀 Natijani ulashish', `result_${result.id}`);

    if (ctx.callbackQuery) {
        try {
            await ctx.editMessageText(text, { reply_markup: keyboard });
        } catch (e) {
            await ctx.deleteMessage().catch(() => {});
            await ctx.reply(text, { reply_markup: keyboard });
        }
    } else {
        await ctx.reply(text, { reply_markup: keyboard });
    }
    
    // Sertifikat berish
    if (accuracy >= 80) {
        try {
            const category = await prisma.category.findUnique({ where: { id: quiz.categoryId }});
            const categoryName = category ? category.name : "Test";

            const certPath = path.join(__dirname, '../../tmp', `Sertifikat_${ctx.from.id}_${Date.now()}.pdf`);
            const doc = new PDFDocument({
                size: [842, 595], // A4 Landscape
                margin: 0
            });

            const stream = fs.createWriteStream(certPath);
            doc.pipe(stream);

            // Orqa fonni qo'yish
            const bgPath = path.join(__dirname, '../../assets/certificate_template.png');
            if (fs.existsSync(bgPath)) {
                doc.image(bgPath, 0, 0, { width: 842, height: 595 });
            }

            // Matnlarni yozish
            doc.font('Helvetica-Bold');
            doc.fontSize(45).fillColor('#c8963e').text('FAHRIY SERTIFIKAT', 0, 150, { align: 'center' });
            
            doc.font('Helvetica').fontSize(20).fillColor('#333333');
            doc.text('Ushbu sertifikat', 0, 240, { align: 'center' });
            
            doc.font('Helvetica-Bold').fontSize(30).fillColor('#1a365d');
            doc.text(ctx.dbUser.firstName.toUpperCase(), 0, 270, { align: 'center' });
            
            doc.font('Helvetica').fontSize(16).fillColor('#333333');
            doc.text('quyidagi testda ko\'rsatgan yuqori natijalari va muvaffaqiyati uchun beriladi:', 0, 310, { align: 'center' });
            
            doc.font('Helvetica-Bold').fontSize(24).fillColor('#1a365d');
            doc.text(categoryName.toUpperCase(), 0, 360, { align: 'center' });
            
            doc.font('Helvetica').fontSize(18).fillColor('#333333');
            doc.text(`Natija: ${quiz.score} ball (${accuracy}%)`, 0, 400, { align: 'center' });
            
            doc.fontSize(14).text(`Sana: ${new Date().toLocaleDateString('uz-UZ')}`, 150, 480);
            
            doc.end();

            stream.on('finish', async () => {
                await ctx.replyWithDocument(new InputFile(certPath), { caption: "🎉 Tabriklaymiz! Sizning maxsus PDF sertifikatingiz." });
                if (fs.existsSync(certPath)) fs.unlinkSync(certPath);
            });
        } catch(e) {
            console.error("PDF yaratishda xatolik:", e);
            const certText = `🎖 <b>FAХRIY SERTIFIKAT</b> 🎖\n\n` +
                             `Hurmatli <b>${ctx.dbUser.firstName}</b>,\n` +
                             `Siz testdan muvaffaqiyatli o'tib, <b>${accuracy}%</b> natija ko'rsatganingiz uchun ushbu sertifikat bilan taqdirlanasiz!\n\n` +
                             `<i>Bilimingizni yanada oshirishda davom eting!</i> 🚀`;
            await ctx.reply(certText, { parse_mode: 'HTML' });
        }
    }
    
    // Hisobot tekshiruvi
    const reportSetting = await prisma.setting.findUnique({ where: { key: 'showReport' } });
    const showReport = reportSetting ? reportSetting.value === 'true' : true; // Default true

    if (showReport && quiz.userAnswers.length > 0) {
        let reportContent = `Batafsil hisobot\nFoydalanuvchi: ${ctx.dbUser.firstName}\nNatija: ${quiz.score}/${quiz.questions.length}\nSana: ${new Date().toLocaleString('uz-UZ')}\n\n`;
        reportContent += '===============================\n\n';

        quiz.userAnswers.forEach(ans => {
            reportContent += `Savol ${ans.questionNumber}: ${ans.questionText}\n`;
            reportContent += `Sizning javobingiz: ${ans.userAnswer} ${ans.isCorrect ? '✅' : '❌'}\n`;
            if (!ans.isCorrect) {
                reportContent += `To'g'ri javob: ${ans.correctAnswer}\n`;
            }
            reportContent += '\n-------------------------------\n\n';
        });

        const tmpPath = path.join(__dirname, '../../tmp', `hisobot_${ctx.from.id}_${Date.now()}.txt`);
        if (!fs.existsSync(path.join(__dirname, '../../tmp'))) {
            fs.mkdirSync(path.join(__dirname, '../../tmp'), { recursive: true });
        }
        
        fs.writeFileSync(tmpPath, reportContent);
        
        await ctx.replyWithDocument(new InputFile(tmpPath), { caption: "📊 Sizning batafsil natijalar hisobotingiz." });
        
        fs.unlinkSync(tmpPath);
    }

    ctx.session.step = 'idle';
    ctx.session.quiz = null;
}

module.exports = { showCategories, startQuiz, handleAnswer, clearUserTimers };
