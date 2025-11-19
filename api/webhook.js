// api/webhook.js

import { Telegraf } from "telegraf";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import dotenv from "dotenv";
import { put, getDownloadUrl, list } from "@vercel/blob";

// Load environment variables
dotenv.config();

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- FIX: Using the Vercel-generated variable name with fallbacks ---
const BLOB_READ_WRITE_TOKEN =
  process.env.BLOB_READ_WRITE_TOKEN_READ_WRITE_TOKEN ||
  process.env.BLOB_READ_WRITE_TOKEN ||
  process.env.VERCEL_BLOB_READ_WRITE_TOKEN;

const CREATOR_NAME = "Eli Bautista";
const BLOB_FILE_KEY = "expenses/kwentako_data.csv";

// Fail-safe check with detailed logging
if (!BOT_TOKEN || !GEMINI_API_KEY || !BLOB_READ_WRITE_TOKEN) {
  console.error("FATAL: Required environment variables are missing.");
  console.error("BOT_TOKEN:", BOT_TOKEN ? "✓ Present" : "✗ Missing");
  console.error("GEMINI_API_KEY:", GEMINI_API_KEY ? "✓ Present" : "✗ Missing");
  console.error(
    "BLOB_READ_WRITE_TOKEN:",
    BLOB_READ_WRITE_TOKEN ? "✓ Present" : "✗ Missing"
  );
  console.error(
    "Available env keys:",
    Object.keys(process.env).filter((key) => key.includes("BLOB"))
  );
}

const bot = new Telegraf(BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const model = "gemini-2.5-flash"; // Lighter model, sufficient for expense parsing

// --- Simplified Schema for Better Performance ---
const expenseSchema = z.object({
  description: z.string().describe("Brief expense description"),
  amount: z.number().describe("Amount in PHP"),
  category: z
    .enum([
      "Food",
      "Transportation",
      "Supplies",
      "Utilities",
      "Personal",
      "Other",
    ])
    .describe("Expense category"),
});
const responseSchema = z.array(expenseSchema);

// Create a simpler, more efficient schema
const simplifiedJsonSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      description: { type: "string" },
      amount: { type: "number" },
      category: {
        type: "string",
        enum: [
          "Food",
          "Transportation",
          "Supplies",
          "Utilities",
          "Personal",
          "Other",
        ],
      },
    },
    required: ["description", "amount", "category"],
  },
};

// -------------------------------------------------------------------
// 3. CSV GENERATION & BLOB HELPERS
// -------------------------------------------------------------------

/**
 * Generates initial CSV with metadata and headers
 */
const generateInitialCSV = () => {
  const now = new Date();
  const timestamp = now.toISOString();
  
  return `# KwentaKo Expense Tracker
# Generated: ${timestamp}
# Creator: ${CREATOR_NAME}
# Total Expenses: ₱0.00
# Total Records: 0
#
# CATEGORY BREAKDOWN:
# Food: ₱0.00 (0%)
# Transportation: ₱0.00 (0%)
# Supplies: ₱0.00 (0%)
# Utilities: ₱0.00 (0%)
# Personal: ₱0.00 (0%)
# Other: ₱0.00 (0%)
#
Date,Description,Amount (PHP),Category
`;
};

/**
 * Generates complete CSV with data, metadata and statistics
 */
const generateCompleteCSV = (expenseRecords) => {
  const now = new Date();
  const timestamp = now.toISOString();
  
  // Calculate statistics
  const total = expenseRecords.reduce((sum, record) => sum + record.amount, 0);
  const categoryTotals = {};
  const categories = ["Food", "Transportation", "Supplies", "Utilities", "Personal", "Other"];
  
  // Initialize categories
  categories.forEach(cat => categoryTotals[cat] = 0);
  
  // Calculate category totals
  expenseRecords.forEach(record => {
    categoryTotals[record.category] = (categoryTotals[record.category] || 0) + record.amount;
  });
  
  // Generate category breakdown with percentages
  const categoryBreakdown = categories.map(cat => {
    const amount = categoryTotals[cat] || 0;
    const percentage = total > 0 ? ((amount / total) * 100).toFixed(1) : '0.0';
    return `# ${cat}: ₱${amount.toFixed(2)} (${percentage}%)`;
  }).join('\n');
  
  // Generate CSV header with metadata
  const header = `# KwentaKo Expense Tracker
# Generated: ${timestamp}
# Creator: ${CREATOR_NAME}
# Total Expenses: ₱${total.toFixed(2)}
# Total Records: ${expenseRecords.length}
#
# CATEGORY BREAKDOWN:
${categoryBreakdown}
#
Date,Description,Amount (PHP),Category`;

  // Generate data rows
  const dataRows = expenseRecords.map(record => 
    `${record.date},"${record.description}",${record.amount},${record.category}`
  );
  
  return [header, ...dataRows].join('\n') + '\n';
};

/**
 * Parses existing CSV content and extracts expense records
 */
const parseExistingCSV = (csvContent) => {
  const lines = csvContent.split('\n');
  const expenses = [];
  
  let inDataSection = false;
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Skip empty lines and comments
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }
    
    // Check if we've reached the header row
    if (trimmedLine.startsWith('Date,Description,Amount')) {
      inDataSection = true;
      continue;
    }
    
    // Parse data rows
    if (inDataSection && trimmedLine) {
      const parts = trimmedLine.split(',');
      if (parts.length >= 4) {
        const date = parts[0];
        const description = parts[1].replace(/"/g, ''); // Remove quotes
        const amount = parseFloat(parts[2]);
        const category = parts[3];
        
        if (!isNaN(amount)) {
          expenses.push({ date, description, amount, category });
        }
      }
    }
  }
  
  return expenses;
};

// -------------------------------------------------------------------
// 4. VERCEL BLOB HELPERS  
// -------------------------------------------------------------------

/**
 * Reads the existing CSV content from the Vercel Blob store.
 * @returns {string} The raw CSV content.
 */
const readBlobContent = async () => {
  try {
    // Method 1: List blobs and find the exact match
    const { blobs } = await list({
      token: BLOB_READ_WRITE_TOKEN,
      prefix: "expenses/", // Use folder prefix instead of exact file
    });

    console.log(
      "Listed blobs:",
      blobs?.map((b) => ({ pathname: b.pathname, uploadedAt: b.uploadedAt }))
    );

    // Find the exact file we want
    const targetBlob = blobs?.find((blob) => blob.pathname === BLOB_FILE_KEY);

    // If no blob found with this key, return initial CSV with metadata
    if (!targetBlob) {
      console.log(
        "No existing blob found with exact pathname, returning default CSV"
      );
      return generateInitialCSV();
    }

    console.log("Found target blob:", {
      pathname: targetBlob.pathname,
      url: targetBlob.url,
      uploadedAt: targetBlob.uploadedAt,
    });

    // Fetch the content from the URL with cache-busting
    const response = await fetch(targetBlob.url + "?t=" + Date.now());

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const content = await response.text();
    console.log("Successfully read blob content, length:", content.length);
    console.log("Content preview:", content.substring(0, 200) + "...");
    return content;
  } catch (listError) {
    console.error(
      "List method failed, trying getDownloadUrl:",
      listError.message
    );

    // Method 2: Fallback to getDownloadUrl
    try {
      const downloadUrl = await getDownloadUrl(BLOB_FILE_KEY, {
        token: BLOB_READ_WRITE_TOKEN,
      });

      console.log("Got download URL:", downloadUrl);

      // Add cache-busting parameter
      const response = await fetch(downloadUrl + "?t=" + Date.now());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const content = await response.text();
      console.log(
        "Successfully read blob content via downloadUrl, length:",
        content.length
      );
      return content;
    } catch (downloadError) {
      console.error("Both methods failed:", downloadError.message);

      // If the file doesn't exist or we can't access it, return the initial header row
      if (
        downloadError.message.includes("404") ||
        downloadError.message.includes("file not found") ||
        downloadError.message.includes("BlobNotFoundError") ||
        downloadError.message.includes("Invalid URL") ||
        listError.message.includes("404") ||
        listError.message.includes("file not found")
      ) {
        console.log("Blob doesn't exist, returning default CSV");
        return generateInitialCSV();
      }

      throw new Error(`Blob Read Error: ${downloadError.message}`);
    }
  }
};

/**
 * Writes the updated CSV data back to Vercel Blob.
 * @param {string} newContent - The full, updated CSV content.
 * @returns {object} The blob metadata, including the public URL.
 */
const writeBlobContent = async (newContent) => {
  console.log("Writing content to blob, length:", newContent.length);
  console.log("Content being written:", newContent);

  // Create a unique filename to avoid caching issues
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const uniqueFilename = `expenses/kwentako_data_${timestamp}.csv`;

  // Write to both the main file and a timestamped backup
  const results = await Promise.all([
    // Main file (with overwrite)
    put(BLOB_FILE_KEY, newContent, {
      token: BLOB_READ_WRITE_TOKEN,
      access: "public",
      contentType: "text/csv",
      allowOverwrite: true,
    }),
    // Timestamped backup
    put(uniqueFilename, newContent, {
      token: BLOB_READ_WRITE_TOKEN,
      access: "public",
      contentType: "text/csv",
    }),
  ]);

  console.log("Main file write result:", results[0]);
  console.log("Backup file write result:", results[1]);

  return results[0]; // Return the main file result
};

/**
 * Uses Gemini to parse Philippine expense text into structured JSON data with retry logic.
 */
const parseExpensesWithAI = async (text, maxRetries = 3) => {
  // Input validation to reduce API load
  if (!text || text.trim().length === 0) {
    throw new Error("Empty input text");
  }

  // Limit input length to prevent excessive token usage
  const maxLength = 500;
  const trimmedText =
    text.length > maxLength ? text.substring(0, maxLength) + "..." : text;

  // Shorter, more efficient prompt
  const prompt = `Extract expenses from this Philippine text. Return JSON array with description, amount (PHP), and category (Food/Transportation/Supplies/Utilities/Personal/Other):

"${trimmedText}"`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: simplifiedJsonSchema, // Using the lighter schema
        },
      });

      const rawJson = response.text.trim();
      const parsedData = JSON.parse(rawJson);
      const date = new Date().toLocaleDateString("en-PH");

      return parsedData.map((record) => ({ ...record, date }));
    } catch (error) {
      console.log(
        `Gemini API attempt ${attempt}/${maxRetries} failed:`,
        error.message
      );

      // Check if it's a service unavailable error (503) or rate limit
      if (
        error.message.includes("503") ||
        error.message.includes("overloaded") ||
        error.message.includes("UNAVAILABLE") ||
        error.message.includes("rate limit")
      ) {
        if (attempt < maxRetries) {
          // Exponential backoff: wait 2^attempt seconds
          const waitTime = Math.pow(2, attempt) * 1000;
          console.log(`Waiting ${waitTime}ms before retry...`);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          continue;
        }
      }

      // If it's not a retryable error or we've exhausted retries, throw the error
      throw error;
    }
  }
};

// -------------------------------------------------------------------
// 4. Bot Commands and Handlers
// -------------------------------------------------------------------

bot.start(async (ctx) => {
  const welcomeMessage = `
👋 Welcome to KwentaKo!
    
Simply send me your expenses. I will log them to secure Vercel Blob storage and send you the updated download link.

✨ *Created by ${CREATOR_NAME}*
    `;
  ctx.replyWithMarkdown(welcomeMessage);
});

// Add verification command
bot.command("verify", async (ctx) => {
  try {
    const content = await readBlobContent();
    const lines = content.split("\n").filter((line) => line.trim() !== "");
    const recordCount = lines.length - 1; // Subtract header

    await ctx.replyWithHTML(
      `🔍 <b>Current CSV Status:</b>\n` +
        `📊 Total records: ${recordCount}\n` +
        `📝 File size: ${content.length} characters\n\n` +
        `📥 <a href="https://cmb6ns1ho2tybzsb.public.blob.vercel-storage.com/expenses/kwentako_data.csv">Download Latest CSV</a>\n\n` +
        `<code>${content}</code>`
    );
  } catch (error) {
    ctx.reply(`❌ Error reading blob: ${error.message}`);
  }
});

// Main text handler
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  // Basic input validation to reduce unnecessary API calls
  if (!text || text.trim().length < 3) {
    return ctx.reply("Please provide more details about your expense.");
  }

  // Check for obvious non-expense messages
  const nonExpensePatterns =
    /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|what|how|why)$/i;
  if (nonExpensePatterns.test(text.trim())) {
    return ctx.reply(
      "I help track expenses. Please send me details like 'bought lunch 150 pesos' or 'taxi fare 80 php'."
    );
  }

  try {
    await ctx.reply("🤖 Analyzing expense with Gemini AI...");

    // 1. PARSE NEW EXPENSES
    const newRecords = await parseExpensesWithAI(text);
    if (newRecords.length === 0) {
      return ctx.reply(
        "❌ Could not extract any expenses from your message. Try being more specific about amount and description."
      );
    }

    // 2. READ EXISTING BLOB DATA
    const existingContent = await readBlobContent();
    console.log("Existing content read, length:", existingContent.length);

    // 3. PARSE EXISTING EXPENSES FROM CSV
    const existingRecords = parseExistingCSV(existingContent);
    console.log("Existing expense records:", existingRecords.length);

    // 4. COMBINE ALL RECORDS
    const allRecords = [...existingRecords, ...newRecords];
    console.log("Total records after adding new:", allRecords.length);

    // 5. GENERATE COMPLETE CSV WITH METADATA
    const updatedContent = generateCompleteCSV(allRecords);
    console.log("Generated CSV content, length:", updatedContent.length);

    // 6. WRITE UPDATED CSV BACK TO BLOB
    const blobMetadata = await writeBlobContent(updatedContent);
    console.log("Blob write result:", blobMetadata);

    // 7. CALCULATE STATISTICS FOR RESPONSE
    const newTotal = newRecords.reduce((acc, curr) => acc + curr.amount, 0);
    const grandTotal = allRecords.reduce((acc, curr) => acc + curr.amount, 0);

    await ctx.replyWithHTML(
      `✅ Added ${newRecords.length} new expenses (₱${newTotal.toFixed(2)})\n` +
      `📊 Total expenses: ${allRecords.length} records (₱${grandTotal.toFixed(2)})\n\n` +
      `📥 Download CSV: <a href="${blobMetadata.url}">Click here</a>\n\n` +
      `🔍 Updated: ${new Date().toISOString()}`
    );
  } catch (error) {
    console.error("Critical Blob/Gemini Error:", error);

    // Check if it's a Gemini API error
    if (
      error.message.includes("503") ||
      error.message.includes("overloaded") ||
      error.message.includes("UNAVAILABLE")
    ) {
      ctx.reply(
        "🚫 The AI service is temporarily overloaded. Please try again in a few minutes. " +
          "This is a temporary issue with Google's servers."
      );
    } else if (
      error.message.includes("rate limit") ||
      error.message.includes("429")
    ) {
      ctx.reply(
        "⏳ Rate limit exceeded. Please wait a moment before sending another expense."
      );
    } else if (error.message.includes("Blob")) {
      ctx.reply(
        "💾 There was an issue saving your data. Please try again or contact support."
      );
    } else {
      ctx.reply(
        "❌ An unexpected error occurred. Please try again later. " +
          "If the problem persists, please contact support."
      );
    }
  }
});

// -------------------------------------------------------------------
// 5. Vercel Handler Function (The Webhook Entry Point)
// -------------------------------------------------------------------

export default async (req, res) => {
  try {
    await bot.handleUpdate(req.body, res);

    // Send 200 OK ONLY if the response hasn't been sent by ctx.reply inside the handlers
    if (!res.headersSent) {
      res.status(200).send("OK");
    }
  } catch (error) {
    console.error("Vercel Webhook execution error:", error.message);

    if (!res.headersSent) {
      res.status(500).send("Internal Server Error");
    }
  }
};
