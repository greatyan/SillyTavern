import fetch from 'node-fetch';
import { Router } from 'express';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import streamifier from 'streamifier';


import { readSecret, SECRET_KEYS } from './secrets.js';

export const router = Router();

router.post('/list', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.AZURE_TTS);

        if (!key) {
            console.warn('Azure TTS API Key not set');
            return res.sendStatus(403);
        }

        const region = req.body.region;

        if (!region) {
            console.warn('Azure TTS region not set');
            return res.sendStatus(400);
        }

        const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`;

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Ocp-Apim-Subscription-Key': key,
            },
        });

        if (!response.ok) {
            console.warn('Azure Request failed', response.status, response.statusText);
            return res.sendStatus(500);
        }

        const voices = await response.json();
        return res.json(voices);
    } catch (error) {
        console.error('Azure Request failed', error);
        return res.sendStatus(500);
    }
});

router.post('/generate', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.AZURE_TTS);

        if (!key) {
            console.warn('Azure TTS API Key not set');
            return res.sendStatus(403);
        }

        const { text, voice, region } = req.body;
        if (!text || !voice || !region) {
            console.warn('Missing required parameters');
            return res.sendStatus(400);
        }

        const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
        const lang = String(voice).split('-').slice(0, 2).join('-');
        const escapedText = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice xml:lang='${lang}' name='${voice}'>${escapedText}</voice></speak>`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': key,
                'Content-Type': 'application/ssml+xml',
                'X-Microsoft-OutputFormat': 'webm-24khz-16bit-mono-opus',
            },
            body: ssml,
        });

        if (!response.ok) {
            console.warn('Azure Request failed', response.status, response.statusText);
            return res.sendStatus(500);
        }

        const audio = Buffer.from(await response.arrayBuffer());
        res.set('Content-Type', 'audio/ogg');
        return res.send(audio);
    } catch (error) {
        console.error('Azure Request failed', error);
        return res.sendStatus(500);
    }
});

function convertToOggLibopus(inputBuffer, inputMimeType) {
    return new Promise((resolve, reject) => {
        const inputStream = streamifier.createReadStream(inputBuffer);
        const chunks = [];

        // Infer input format from MIME type (e.g., "audio/webm" => "webm")
        const format = inputMimeType.split('/')[1];

        ffmpeg(inputStream)
            .inputFormat(format)
            .audioCodec('libopus')
            .format('ogg')
            .on('error', reject)
            .on('end', () => {
                resolve(Buffer.concat(chunks));
            })
            .pipe()
            .on('data', (chunk) => chunks.push(chunk));
    });
}

const upload = multer();
router.post('/recognize', upload.fields([
    { name: 'audioFile', maxCount: 1 },
    { name: 'lang', maxCount: 1 },
    { name: 'region', maxCount: 1 },
]), async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.AZURE_TTS);
        if (!key) {
            console.warn('Azure TTS API Key not set');
            return res.sendStatus(403);
        }
        const { lang, region } = req.body;
        const audioFile = req.files.audioFile[0];
        if (!lang || !region || !audioFile) {
            console.warn('Missing required parameters');
            return res.sendStatus(400);
        }
        const oggBuffer = await convertToOggLibopus(audioFile.buffer, audioFile.mimetype);
        const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${lang}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': key,
                'Content-type': 'audio/ogg; codecs=opus',
            },
            body: oggBuffer,
        });

        if (!response.ok) {
            console.warn('Azure Request failed', response.status, response.statusText);
            return res.sendStatus(500);
        }
        const transcriptionResult = await response.json();
        res.set('Content-Type', 'application/json');
        return res.send(transcriptionResult);
    } catch (error) {
        console.error('Azure Request failed', error);
        return res.sendStatus(500);
    }

});
