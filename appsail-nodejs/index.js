import axios from 'axios';
import zlib from 'zlib';
import http from 'http';
import OpenAI from 'openai';

const PORT = process.env.PORT || 9000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const THREAD_ID = process.env.THREAD_ID;

if (!OPENAI_API_KEY) {
  console.log("NO HAY API KEY");
  throw new Error('Missing OPENAI_API_KEY in environment variables');
}

const openai = new OpenAI(OPENAI_API_KEY);

console.log("A punto de entrar a requestHandler: ", PORT);

const cleanData = (data) => {
  if (Array.isArray(data)) {
    return [...new Set(data)].join(' or ');
  }
  return data;
};

const extractJson = (response) => {
  const jsonRegex = /```json([\s\S]*?)```/;
  const match = response.match(jsonRegex);
  if (match && match[1]) {
    return match[1].trim();
  }
  return null;
};

const requestHandler = async (req, res) => {
  if (req.method === 'POST' && req.url === '/transcription_calls_analysis_function') {
    console.log("Handling POST request at /transcription_calls_analysis_function");
    let body = '';

    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', async () => {
      try {
        const { compressedData } = JSON.parse(body);
        const buffer = Buffer.from(compressedData, 'base64');
        const decompressedData = zlib.gunzipSync(buffer).toString();
        const parsedBody = JSON.parse(decompressedData);

        const {
          isClient,
          caller_name,
          ClientEmail,
          services,
          date_created,
          deepgram_response_object,
          phone_number,
          salesRepresentative,
          keywords,
          websiteVisited
        } = parsedBody;

        const fixedPrompt = `
          Datos:
          3.1 Cliente: ${isClient}
            If Yes, include:
            3.1.1 Name: ${cleanData(caller_name)}
            3.1.2 Email: ${cleanData(ClientEmail)}
            3.1.3 Sales Representative: ${cleanData(salesRepresentative)}
            3.1.4 Service of Interest: ${cleanData(services)}
            3.1.5 Last Contact Date: ${date_created}
          3.2 Call Transcript: ${deepgram_response_object}
          3.3 Keywords and Website Visited: ${cleanData(keywords)} and ${cleanData(websiteVisited)}
          3.4 Teléfono: ${phone_number}
        `.replace(/\s+/g, ' ').trim();

        // Imprime el fixedPrompt en el log en partes
        const MAX_LOG_LENGTH = 6000;
        if (fixedPrompt.length > MAX_LOG_LENGTH) {
          for (let i = 0; i < fixedPrompt.length; i += MAX_LOG_LENGTH) {
            console.log(fixedPrompt.substring(i, i + MAX_LOG_LENGTH));
          }
        } else {
          console.log(fixedPrompt);
        }

        // Agrega un mensaje al hilo
        const message = await openai.beta.threads.messages.create(THREAD_ID, {
          role: "user",
          content: fixedPrompt
        });
        console.log("Message ID: ", message.id);

        let fullResponse = '';

        // Ejecución del hilo con el asistente
        const run = openai.beta.threads.runs.stream(THREAD_ID, {
          assistant_id: ASSISTANT_ID
        })
        .on('textCreated', (text) => process.stdout.write('\nassistant > '))
        .on('textDelta', (textDelta, snapshot) => {
          process.stdout.write(textDelta.value);
          fullResponse += textDelta.value;
        })
        .on('toolCallCreated', (toolCall) => process.stdout.write(`\nassistant > ${toolCall.type}\n\n`))
        .on('toolCallDelta', (toolCallDelta, snapshot) => {
          if (toolCallDelta.type === 'code_interpreter') {
            if (toolCallDelta.code_interpreter.input) {
              process.stdout.write(toolCallDelta.code_interpreter.input);
            }
            if (toolCallDelta.code_interpreter.outputs) {
              process.stdout.write("\noutput >\n");
              toolCallDelta.code_interpreter.outputs.forEach(output => {
                if (output.type === "logs") {
                  process.stdout.write(`\n${output.logs}\n`);
                }
              });
            }
          }
        })
        .on('end', () => {
          console.log('\nStream ended');
          // Extraer el JSON de la respuesta antes de enviarla a Postman
          const jsonResponse = extractJson(fullResponse);
          if (jsonResponse) {
            try {
              const parsedJson = JSON.parse(jsonResponse); // Convertir la respuesta a JSON
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(parsedJson)); // Enviar la respuesta JSON formateada
            } catch (error) {
              console.error('Error parsing JSON:', error);
              if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: "Error", error: "Invalid JSON response from assistant" }));
              }
            }
          } else {
            console.error('No valid JSON found in the response.');
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ message: "Error", error: "No valid JSON response from assistant" }));
            }
          }
        })
        .on('error', (error) => {
          console.error('Error in stream:', error);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: "Error", error: error.message }));
          }
        });

      } catch (error) {
        console.error('Error processing request:', error);

        // Retornar "Error" en caso de fallo
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: "Error", error: error.message }));
        }
      }
    });

    req.on('error', (err) => {
      console.error('Error in request:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: "Error", error: err.message }));
      }
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    console.log("Response sent: Not Found");
  }
};

const server = http.createServer((req, res) => {
  requestHandler(req, res);
});

server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

export default server;
