// api/webhook.js

import { Telegraf } from "telegraf";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import dotenv from "dotenv";

// Load environment variables locally (Vercel loads them automatically)
dotenv.config();

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CREATOR_NAME = "Eli Bautista";

// --- GOOGLE SHEETS CONFIG ---
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Sheet1";
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY;

// Fail-safe check
if (!BOT_TOKEN || !GEMINI_API_KEY || !SPREADSHEET_ID || !GOOGLE_PRIVATE_KEY) {
  console.error("FATAL: Configuration variables are missing.");
}

// -------------------------------------------------------------------
// 2. Client Setup & Authentication
// -------------------------------------------------------------------

const bot = new Telegraf(BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const model = "gemini-2.5-flash";

// Sheets Auth: Replace escaped newlines with actual newlines
const auth = new google.auth.JWT({
  email: GOOGLE_CLIENT_EMAIL,
  key: GOOGLE_PRIVATE_KEY ? GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n") : "",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// --- Gemini Schema Definition ---
const expenseSchema = z.object({
  description: z
    .string()
    .describe("A brief description of the expense item..."),
  amount: z.number().describe("The numerical value of the expense..."),
  category: z
    .enum([
      "Food",
      "Transportation",
      "Supplies",
      "Utilities",
      "Personal",
      "Other",
    ])
    .describe("The assigned expense category."),
});
const responseSchema = z.array(expenseSchema);
const jsonSchema = zodToJsonSchema(responseSchema);

// -------------------------------------------------------------------
// 3. Google Sheets Functions
// -------------------------------------------------------------------

/**
 * Uses Gemini to parse Philippine expense text into structured JSON data.
 */
const parseExpensesWithAI = async (text) => {
  // Prompt includes localization context
  const prompt = `You are an expert financial assistant operating in the Philippines. Analyze the following user input and extract all separate expenses. Assume all currency is in Philippine Peso (PHP) unless otherwise specified. Input: "${text}"`;

  const response = await ai.models.generateContent({
    model: model,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: jsonSchema,
    },
  });

  const rawJson = response.text.trim();
  const parsedData = JSON.parse(rawJson);
  const date = new Date().toLocaleDateString("en-PH"); // Localized date

  return parsedData.map((record) => ({ ...record, date }));
};

/**
 * Appends records to the Google Sheet.
 */
const appendRecordsToSheet = async (records) => {
  // Transform records to arrays: [Date, Description, Amount, Category]
  const rows = records.map((r) => [
    r.date,
    r.description,
    r.amount,
    r.category,
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:D`, // Assumes columns A, B, C, D
    valueInputOption: "USER_ENTERED",
    resource: {
      values: rows,
    },
  });
};

/**
 * Fetches all data from the sheet and calculates statistics.
 */
const getStatsFromSheet = async () => {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:D`,
  });

  const rows = response.data.values ? response.data.values.slice(1) : []; // Skip header row

  let totalAmount = 0;
  const categoryTotals = {};
  let recordCount = 0;

  for (const row of rows) {
    const amount = parseFloat(row[2]);
    const category = row[3] || "Other";

    if (!isNaN(amount)) {
      totalAmount += amount;
      recordCount++;
      categoryTotals[category] = (categoryTotals[category] || 0) + amount;
    }
  }

  if (recordCount === 0) {
    return { summary: "No expenses found in Google Sheet." };
  }

  const averageExpense = totalAmount / recordCount;
  const topCategory = Object.entries(categoryTotals).reduce(
    (a, b) => (a[1] > b[1] ? a : b),
    ["", 0]
  );

  let categoryBreakdown = Object.entries(categoryTotals)
    .map(([cat, sum]) => `\n   - ${cat}: ₱${sum.toFixed(2)}`)
    .join("");

  const summary = `
📊 **KwentaKo Statistics Summary**
---
* **Total Expenses Recorded:** ${recordCount}
* **Total Spending (Lifetime):** ₱${totalAmount.toFixed(2)}
* **Average Expense Amount:** ₱${averageExpense.toFixed(2)}
* **Top Category:** ${topCategory[0]} (₱${topCategory[1].toFixed(2)})

**Category Breakdown:**${categoryBreakdown}

📁 **Data Source:** Google Sheet
* **Created by:** ${CREATOR_NAME}
    `;

  return { summary };
};

// -------------------------------------------------------------------
// 4. Bot Commands and Handlers
// -------------------------------------------------------------------

bot.start(async (ctx) => {
  const welcomeMessage = `
👋 Welcome to KwentaKo!
    
Simply send me your expenses, and **Gemini AI** will log them into your Google Sheet. Currency is assumed to be **Philippine Peso (₱)**.

✨ *Created by ${CREATOR_NAME}*
    `;
  ctx.replyWithMarkdown(welcomeMessage);
});

bot.help((ctx) => {
  const helpMessage = `
📚 **Available Commands:**
* \`/download_csv\`: Sends you the latest statistics and a download link.

Bot created by **${CREATOR_NAME}**.
    `;
  ctx.replyWithMarkdown(helpMessage);
});

// Main text handler
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  try {
    await ctx.reply("🤖 Analyzing expense with Gemini AI...");

    const newRecords = await parseExpensesWithAI(text);

    if (newRecords.length === 0) {
      return ctx.reply(
        "AI could not extract any expenses. Please try a different phrasing, specifying the amount clearly."
      );
    }

    // --- WRITE TO GOOGLE SHEETS ---
    await appendRecordsToSheet(newRecords);

    const total = newRecords.reduce((acc, curr) => acc + curr.amount, 0);
    ctx.reply(
      `✅ Saved ${
        newRecords.length
      } items to Google Sheet. Total: ₱${total.toFixed(2)}`
    );
  } catch (error) {
    console.error("Error processing with Sheets:", error);
    ctx.reply(
      "Error saving data. Check your Sheet ID, Permissions, or Vercel logs."
    );
  }
});

// Command to download the data
bot.command("download_csv", async (ctx) => {
  try {
    const { summary } = await getStatsFromSheet();

    await ctx.replyWithMarkdown(summary);

    // Send a direct download/view link
    const viewUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`;
    const downloadUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=xlsx&id=${SPREADSHEET_ID}`;

    await ctx.replyWithHTML(`
📥 **View or Download Your Data:**
* **View Online:** <a href="${viewUrl}">Open Google Sheet</a>
* **Download Excel (.xlsx):** <a href="${downloadUrl}">Download File</a>
        `);
  } catch (error) {
    console.error("Error with Google Sheets API:", error);
    ctx.reply(
      "Could not access Google Sheets. Check your API key and Sheet ID/Permissions."
    );
  }
});

// -------------------------------------------------------------------
// 5. Vercel Handler Function (The Webhook Entry Point)
// -------------------------------------------------------------------

// This function is what Vercel executes on every incoming HTTP request (webhook)
export default async (req, res) => {
  try {
    // Handle the incoming webhook from Telegram
    await bot.handleUpdate(req.body, res);

    // Send a quick response back to Telegram
    res.status(200).send("OK");
  } catch (error) {
    console.error("Vercel Webhook execution error:", error.message);
    res.status(500).send("Internal Server Error");
  }
};
