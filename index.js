import pkg from "qrcode-terminal";
import Whatsapp from "whatsapp-web.js";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, set, child } from "firebase/database";
import { Configuration, OpenAIApi } from "openai";
import express from "express";
import qr2 from "qrcode";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { config } from "dotenv";
import multer from "multer";
import { parse } from "csv-parse";
import fs from "fs";

config();

const { Client, LocalAuth } = Whatsapp;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const appEx = express();
appEx.use(express.urlencoded({ extended: true }));

// Set up multer for file uploads
const upload = multer({ dest: 'uploads/' });

const firebaseConfig = {
    apiKey: process.env.API_KEY,
    authDomain: process.env.AUTH_DOMAIN,
    databaseURL: process.env.DATABASE_URL,
    projectId: process.env.PROJECT_ID,
    storageBucket: process.env.STORAGE_BUCKET,
    messagingSenderId: process.env.MESSAGING_SENDER_ID,
    appId: process.env.APP_ID,
};

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
const dbRef = ref(database);

const configuration = new Configuration({
    apiKey: process.env.OPEN_AI_KEY,
});

const openai = new OpenAIApi(configuration);

// Global client instance
let whatsappClient = null;

// Initialize WhatsApp client
function initializeWhatsAppClient() {
    if (!whatsappClient) {
        whatsappClient = new Client({
            authStrategy: new LocalAuth({ clientId: "bulk-sender" }),
        });

        whatsappClient.on("qr", (qrCode) => {
            pkg.generate(qrCode, { small: true });
        });

        whatsappClient.on("ready", () => {
            console.log("WhatsApp client is ready!");
        });

        whatsappClient.on("message", handleIncomingMessage);
        whatsappClient.initialize();
    }
    return whatsappClient;
}

async function handleIncomingMessage(message) {
    const chat = await message.getChat();
    const userId = chat.id.user;

    // Get existing conversation from Firebase
    const snapshot = await get(child(dbRef, `/links/test/${userId}`));
    let arr_chat = [];

    if (snapshot.exists()) {
        arr_chat = snapshot.val().messages;
    }

    // Add user message to conversation
    arr_chat.push({
        role: "user",
        content: message.body,
    });

    // Check if user wants to end conversation
    if (message.body.toLowerCase().includes("i don't need your services")) {
        message.reply("Thank you for your time. If you change your mind, feel free to reach out!");
        return;
    }

    // Get AI response
    const completion = await openai.createChatCompletion({
        model: "gpt-3.5-turbo",
        messages: arr_chat,
    });

    const aiResponse = completion.data.choices[0].message.content;
    message.reply(aiResponse);

    // Add AI response to conversation
    arr_chat.push({
        role: "system",
        content: aiResponse,
    });

    // Save updated conversation to Firebase
    await set(ref(database, `/links/test/${userId}`), {
        messages: arr_chat,
    });
}

// Handle CSV upload and bulk messaging
appEx.post("/upload", upload.single('csvFile'), async (req, res) => {
    if (!req.file || !req.body.initialMessage) {
        return res.status(400).send("Please provide both CSV file and initial message");
    }

    const client = initializeWhatsAppClient();
    const results = [];

    // Parse CSV file
    fs.createReadStream(req.file.path)
        .pipe(parse({ columns: true }))
        .on("data", (data) => {
            results.push(data);
        })
        .on("end", async () => {
            // Clean up uploaded file
            fs.unlinkSync(req.file.path);

            // Process each contact
            for (const contact of results) {
                const phoneNumber = contact.phone_number.replace(/\D/g, '');
                const message = `Hello ${contact.firstname} ${contact.lastname} from ${contact.company_name}, ${req.body.initialMessage}`;

                try {
                    // Initialize conversation in Firebase
                    await set(ref(database, `/links/test/${phoneNumber}`), {
                        messages: [{
                            role: "system",
                            content: req.body.initialMessage,
                        }],
                    });

                    // Send message
                    await client.sendMessage(`${phoneNumber}@c.us`, message);
                } catch (error) {
                    console.error(`Error sending message to ${phoneNumber}:`, error);
                }
            }

            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>WhatsGPT - Bulk Messages Sent</title>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <link rel="stylesheet" href="https://www.w3schools.com/w3css/4/w3.css">
                    <link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Raleway">
                    <style>
                        body,h1 {font-family: "Raleway", sans-serif}
                        body, html {height: 100%}
                        .bgimg {
                            background-image: url('https://w0.peakpx.com/wallpaper/818/148/HD-wallpaper-whatsapp-background-cool-dark-green-new-theme-whatsapp.jpg');
                            min-height: 100%;
                            background-position: center;
                            background-size: cover;
                        }
                    </style>
                </head>
                <body>
                    <div class="bgimg w3-display-container w3-animate-opacity w3-text-white">
                        <div class="w3-display-middle">
                            <h2 class="w3-jumbo w3-animate-top">Messages Sent!</h2>
                            <hr class="w3-border-grey" style="margin:auto;width:40%">
                            <p class="w3-large w3-center">Bulk messages have been sent to ${results.length} contacts.</p>
                            <p class="w3-center"><a href="/" class="w3-button w3-white">Back to Home</a></p>
                        </div>
                    </div>
                </body>
                </html>
            `);
        });
});

appEx.get("/", (req, res) => {
    res.sendFile(__dirname + "/index.html");
});

appEx.post("/submit", (req, res) => {
    const message = req.body.message;
    const phoneNumber = req.body.phoneNumber;
    res.redirect("/authenticate/" + phoneNumber + "/" + message);
});

appEx.get("/authenticate/:phoneNumber/:promt", (req, res) => {
    const phoneNumber = req.params.phoneNumber;
    const promt = req.params.promt;
    const client = initializeWhatsAppClient();

    client.on("qr", (qrCode) => {
        qr2.toDataURL(qrCode, (err, src) => {
            if (err) return res.send("Error occurred");
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>WhatsGPT</title>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <link rel="stylesheet" href="https://www.w3schools.com/w3css/4/w3.css">
                    <link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Raleway">
                    <style>
                        body,h1 {font-family: "Raleway", sans-serif}
                        body, html {height: 100%}
                        .bgimg {
                            background-image: url('https://w0.peakpx.com/wallpaper/818/148/HD-wallpaper-whatsapp-background-cool-dark-green-new-theme-whatsapp.jpg');
                            min-height: 100%;
                            background-position: center;
                            background-size: cover;
                        }
                    </style>
                </head>
                <body>
                    <div class="bgimg w3-display-container w3-animate-opacity w3-text-white">
                        <div class="w3-display-topleft w3-padding-large w3-xlarge">
                            WhatsGPT
                        </div>
                        <div class="w3-display-middle">
                            <center>
                                <h2 class="w3-jumbo w3-animate-top">QRCode Generated</h2>
                                <hr class="w3-border-grey" style="margin:auto;width:40%">
                                <p class="w3-center"><div><img src='${src}'/></div></p>
                            </center>
                        </div>
                        <div class="w3-display-bottomleft w3-padding-large">
                            Powered by <a href="/" target="_blank">WhatsGPT</a>
                        </div>
                    </div>
                </body>
                </html>
            `);
        });
    });
});

appEx.listen(process.env.PORT, function () {
    console.log("Example app listening on port " + process.env.PORT + "!");
});