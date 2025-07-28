// ✅ Required Modules
const {Telegraf} = require('telegraf');
const fetch = require('node-fetch');
require('dotenv').config();
const admin = require('firebase-admin');
const cron = require('node-cron');
const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

// ✅ Bot & Firebase Setup
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id,
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});

const db = admin.firestore();

// ✅ Bot Commands
bot.start((ctx) => ctx.reply('Welcome to Movies Arena! 🍿'));

// ✅ Export Bot via Firebase HTTPS function
exports.bot = onRequest((req, res) => {
  logger.info("Webhook received", req.body);
  bot.handleUpdate(req.body, res);
});

// 🔍 Movie Details Fetcher
async function fetchMovieDetails(query) {
  const url = `https://api.themoviedb.org/3/search/movie?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  const data = await res.json();
  const movie = data.results?.[0];
  if (!movie) return null;

  const detailsUrl = `https://api.themoviedb.org/3/movie/${movie.id}?api_key=${process.env.TMDB_API_KEY}&append_to_response=credits`;
  const fullRes = await fetch(detailsUrl);
  const fullData = await fullRes.json();
  return fullData;
}

// 🧠 Quiz Generator
function generateMovieQuiz(movie) {
  const questions = [];

  if (movie.genres?.length) {
    questions.push({
      question: `What's a genre of "${movie.title}"?`,
      options: [movie.genres[0].name, "Comedy", "Romance", "Sci-Fi"],
      answer: 0
    });
  }

  if (movie.credits?.cast?.length >= 3) {
    const actors = movie.credits.cast.slice(0, 4).map(c => c.name);
    questions.push({
      question: `Who stars in "${movie.title}"?`,
      options: actors,
      answer: 0
    });
  }

  if (movie.overview) {
    const sample = movie.overview.split(" ").slice(3, 10).join(" ");
    questions.push({
      question: `Complete this: “…${sample} ___.”`,
      options: ["plot", "conflict", "resolution", "twist"],
      answer: 1
    });
  }

  return questions.sort(() => Math.random() - 0.5);
}

// 🎯 Movie Quiz Command
bot.command('quiz', async (ctx) => {
  const uid = ctx.from.id.toString();
  const query = ctx.message.text.split(' ').slice(1).join(' ') || 'Inception';
  const movie = await fetchMovieDetails(query);
  if (!movie) return ctx.reply('❌ No matching movie.');

  const questions = generateMovieQuiz(movie);

  await db.collection('users').doc(uid).set({
    currentQuiz: {title: movie.title, questions, score: 0, index: 0}
  }, {merge: true});

  const q = questions[0];
  await ctx.reply(`🧠 ${q.question}`, {
    reply_markup: {
      inline_keyboard: q.options.map((opt, i) => [
        {text: opt, callback_data: `quiz_${i}_${q.answer}_${movie.title}`}
      ])
    }
  });
});

bot.on('callback_query', async (ctx) => {
  const uid = ctx.from.id.toString();
  const data = ctx.update.callback_query.data;
  const userRef = db.collection('users').doc(uid);
  const userDoc = await userRef.get();

  // 🎖️ Show Leaderboard
  if (data === 'show_leaderboard') {
    const top = await db.collection('users').orderBy('score', 'desc').limit(10).get();
    const board = top.docs.map((doc, i) => {
      const u = doc.data();
      const medal = u.score >= 300 ? '🥇' : u.score >= 150 ? '🥈' : '🥉';
      return `${i + 1}. ${u.nickname || 'Anonymous'} — ${u.score || 0} pts ${medal}`;
    }).join('\n');
    await ctx.reply(`🏆 *Leaderboard*\n\n${board}`, {parse_mode: 'Markdown'});
    return ctx.answerCbQuery();
  }

  // ✅ Daily Quiz Answer
  if (data.startsWith('quiz_') && userDoc.data()?.dailyQuiz) {
    const selected = parseInt(data.split('_')[1]);
    const correct = userDoc.data().dailyQuiz?.answer;
    const scoreInc = selected === correct ? 15 : 0;
    const message = selected === correct ? '✅ Correct!' : '❌ Wrong! Try again later.';

    await userRef.set({
      score: (userDoc.data().score || 0) + scoreInc
    }, {merge: true});

    await ctx.reply(message);
    return ctx.answerCbQuery();
  }

  // ✅ Movie Quiz Answer
  if (data.startsWith('quiz_') && userDoc.data()?.movieQuiz) {
    const [, selectedStr, answerStr, title] = data.split('_');
    const selected = parseInt(selectedStr);
    const answer = parseInt(answerStr);
    const session = userDoc.data().movieQuiz;

    const isCorrect = selected === answer;
    const feedback = isCorrect ? '✅ Correct!' : '❌ Nope!';
    const newScore = (session.score || 0) + (isCorrect ? 1 : 0);
    const nextIndex = session.index + 1;
    const nextQuestion = session.questions[nextIndex];

    await userRef.set({
      movieQuiz: {
        ...session,
        score: newScore,
        index: nextIndex
      }
    }, {merge: true});

    await ctx.answerCbQuery(feedback);

    if (nextQuestion) {
      await ctx.reply(`🧠 ${nextQuestion.question}`, {
        reply_markup: {
          inline_keyboard: nextQuestion.options.map((opt, i) => [
            {text: opt, callback_data: `quiz_${i}_${nextQuestion.answer}_${title}`}
          ])
        }
      });
    } else {
      await ctx.reply(`🏁 Quiz complete!\nYou scored *${newScore}* point(s) for "${title}"`, {parse_mode: 'Markdown'});
    }
    return;
  }

  // 😂😱😢 Mood-Based Suggestion
  if (data.startsWith('mood_')) {
    const genreMap = {
      mood_comedy: 35,
      mood_thriller: 53,
      mood_drama: 18
    };
    const genreId = genreMap[data];
    const res = await fetch(`https://api.themoviedb.org/3/discover/movie?api_key=${process.env.TMDB_API_KEY}&with_genres=${genreId}&sort_by=popularity.desc`);
    const dataResult = await res.json();
    const pick = dataResult.results[0];
    const trailer = `https://youtube.com/results?search_query=${pick.title}+trailer`;
    const poster = `https://image.tmdb.org/t/p/w500${pick.poster_path}`;

    await ctx.replyWithPhoto(poster, {
      caption: `🎬 *${pick.title}*\n⭐ ${pick.vote_average}/10`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{text: '🎞️ Trailer', url: trailer}]]
      }
    });

    return ctx.answerCbQuery();
  }

  // 👍 Swipe Vote Response
  if (data.startsWith('vote_')) {
    await ctx.answerCbQuery('🙌 Vote recorded!');
    await ctx.reply('Thanks for voting! 🎉');
    return;
  }

  // 🎭 Genre Selection
  if (data.startsWith('genre_')) {
    await ctx.answerCbQuery();
    await ctx.reply(`🎉 You chose *${data.split('_')[1]}* genre`, {parse_mode: 'Markdown'});
    return;
  }
});

// ✅ Duel Requests
bot.command('duel', async (ctx) => {
  const challenger = ctx.from.id.toString();
  const opponent = ctx.message.text.split(' ')[1];
  await db.collection('duels').add({challenger, opponent, status: 'pending'});
  ctx.reply(`🤜 Duel requested with user ${opponent}!`);
});
// ✅ Monthly Poster
bot.command('monthlyPoster', async (ctx) => {
  const top = await db.collection('users').orderBy('score', 'desc').limit(3).get();
  let msg = "🏆 *Top Movie Masters of the Month*\n\n";
  top.docs.forEach((doc, i) => {
    const u = doc.data();
    msg += `${i + 1}. ${u.nickname || 'Anonymous'} — ${u.score || 0} pts\n`;
  });
  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ✅ Movie Search
bot.on('text', async (ctx) => {
  const uid = ctx.from.id.toString();
  const query = ctx.message.text;
  const url = `https://api.themoviedb.org/3/search/movie?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  const data = await res.json();
  const movie = data.results?.[0];
  if (!movie || !movie.poster_path) return ctx.reply('🙅🏽‍♂️ No movie found. Try another title.');

  const poster = `https://image.tmdb.org/t/p/w500${movie.poster_path}`;
  const trailer = `https://youtube.com/results?search_query=${movie.title}+trailer`;

  await ctx.replyWithPhoto(poster, {
    caption: `🎬 *${movie.title}* (${movie.release_date?.split('-')[0]})\n🗂️ ${movie.overview || 'No summary available.'}`,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎞️ Watch Trailer', url: trailer }],
        [{ text: '📥 Download Here', url: 'https://t.me/+hQhgJAAoSaY0OGZk' }],
        [{ text: '📊 Leaderboard', callback_data: 'show_leaderboard' }]
      ]
    }
  });

  await sendSimilarAndUpdateScore(movie, ctx, uid);
});

// ✅ Similar Movies & Score Update
async function sendSimilarAndUpdateScore(movie, ctx, uid) {
  const similarRes = await fetch(`https://api.themoviedb.org/3/movie/${movie.id}/similar?api_key=${process.env.TMDB_API_KEY}`);
  const similarData = await similarRes.json();
  const topSimilar = similarData.results.slice(0, 2).map(m => m.title).join(', ');
  await ctx.reply(`✨ You might also like: ${topSimilar}`);

  const userRef = db.collection('users').doc(uid);
  await db.runTransaction(async (t) => {
    const doc = await t.get(userRef);
    const oldScore = doc.exists ? doc.data().score || 0 : 0;
    t.set(userRef, { score: oldScore + 10 }, { merge: true });
  });
}

// ✅ Callback Query Handler
bot.on('callback_query', async (ctx) => {
  const uid = ctx.from.id.toString();
  const data = ctx.update.callback_query.data;
  const userRef = db.collection('users').doc(uid);
  const userDoc = await userRef.get();

  // 🎖️ Leaderboard
  if (data === 'show_leaderboard') {
    const top = await db.collection('users').orderBy('score', 'desc').limit(10).get();
    const board = top.docs.map((doc, i) => {
      const u = doc.data();
      const medal = u.score >= 300 ? '🥇' : u.score >= 150 ? '🥈' : '🥉';
      return `${i + 1}. ${u.nickname || 'Anonymous'} — ${u.score || 0} pts ${medal}`;
    }).join('\n');
    await ctx.reply(`🏆 *Leaderboard*\n\n${board}`, { parse_mode: 'Markdown' });
    return ctx.answerCbQuery();
  }

  // ✅ Quiz Answer Response
  if (data.startsWith('quiz_')) {
    const selected = parseInt(data.split('_')[1]);
    const correct = userDoc.exists ? userDoc.data().currentQuizAnswer : null;

    if (selected === correct) {
      await ctx.reply('✅ Correct!');
      await userRef.set({ score: (userDoc.data().score || 0) + 15 }, { merge: true });
    } else {
      await ctx.reply('❌ Wrong! Try again later.');
    }

    return ctx.answerCbQuery();
  }

  // 🎭 Mood-Based Suggestion
  const genreMap = {
    mood_comedy: 35,
    mood_thriller: 53,
    mood_drama: 18,
    genre_comedy: 35,
    genre_thriller: 53,
    genre_drama: 18
  };

  if (data.startsWith("mood_")) {
    const genreId = genreMap[data];
    const url = `https://api.themoviedb.org/3/discover/movie?api_key=${process.env.TMDB_API_KEY}&with_genres=${genreId}&sort_by=popularity.desc`;
    const res = await fetch(url);
    const dataResult = await res.json();
    const pick = dataResult.results[0];
    const trailer = `https://youtube.com/results?search_query=${pick.title}+trailer`;
    const poster = `https://image.tmdb.org/t/p/w500${pick.poster_path}`;

    await ctx.replyWithPhoto(poster, {
      caption: `🎬 *${pick.title}*\n⭐ ${pick.vote_average}/10`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🎞️ Trailer', url: trailer }]]
      }
    });

    return ctx.answerCbQuery();
  }

  // 👍 Swipe Vote Response
  if (data.startsWith('vote_')) {
    await ctx.answerCbQuery('🙌 Vote recorded!');
    await ctx.reply('Thanks for voting! 🎉');
    return;
  }

  // 🎭 Genre Selection
  if (data.startsWith("genre_")) {
    const genreKey = data.split('_')[1];
    await ctx.answerCbQuery();
    await ctx.reply(`🎉 You chose *${genreKey}* genre`, { parse_mode: 'Markdown' });
    return;
  }
});

// ✅ Time-Based Greetings
cron.schedule('0 8 * * *', async () => {
  const users = await db.collection('users').get();
  for (const user of users.docs) {
    await bot.telegram.sendMessage(user.id, "☀️ Morning! Ready to earn quiz points?");
  }
});

cron.schedule('0 22 * * *', async () => {
  const users = await db.collection('users').get();
  for (const user of users.docs) {
    await bot.telegram.sendMessage(user.id, "🌙 Wind down with a thriller or drama tonight?");
  }
});

// ✅ Daily Movie Alerts
cron.schedule('0 9 * * *', async () => {
  const res = await fetch(`https://api.themoviedb.org/3/movie/upcoming?api_key=${process.env.TMDB_API_KEY}&language=en-US`);
  const data = await res.json();
  const movies = data.results.slice(0, 2);
  const users = await db.collection('users').get();

  for (const movie of movies) {
    const poster = `https://image.tmdb.org/t/p/w500${movie.poster_path}`;
    const msg = `🎬 *${movie.title}*\n🗓️ ${movie.release_date}\n🖼️ Poster:\n${poster}`;
    for (const doc of users.docs) {
      await bot.telegram.sendMessage(doc.id, msg, { parse_mode: 'Markdown' });
    }
  }
});

// ✅ Monthly Score Reset
cron.schedule('0 0 1 * * *', async () => {
  const users = await db.collection('users').get();
  const batch = db.batch();

  users.forEach(doc => {
    const u = doc.data();
    const badge = u.score >= 300 ? '🥇 Gold' : u.score >= 150 ? '🥈 Silver' : '🥉 Bronze';

    batch.update(doc.ref, {
      lastScore: u.score || 0,
      lastTier: badge,
      score: 0
    });

    bot.telegram.sendMessage(doc.id,
      `📆 Monthly Reset!\n🏅 Your Tier: ${badge}\n🎯 Final Score: ${u.score || 0}`,
      { parse_mode: 'Markdown' });
  });

  await batch.commit();
});

// ✅ Launch Your Movie Bot
bot.launch();