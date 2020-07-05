import express from 'express';
import request from 'request';
import cheerio from 'cheerio';

const PORT = Number(process.env.PORT || 3000);

const app = express();

app.get('/', ({query: {url: requestedUrl}}, response) => {
  if (requestedUrl) {
    new Promise((resolve, reject) => {
      try {
        console.log(requestedUrl);

        request(requestedUrl, (error, response, body) => {
          if (!error && response.statusCode === 200) {
            const $ = cheerio.load(body);
            const $title = $('head > title');
            const $description = $('meta[name="description"]');

            resolve({
              title: $title && $title.text().trim() || '',
              description: $description && $description.attr('content') && $description.attr('content').trim() || '',
            })
          } else {
            reject({
              code: 500,
              message: error,
            });
          }
        });
      } catch (e) {
        reject({
          code: 400,
          message: e.message,
        });
      }
    })
      .then((data) => {
        console.log(data);
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.end(JSON.stringify(data));
      })
      .catch((error = {}) => {
        const {code = 500, message = 'Server error'} = error;
        response.status = code;
        response.end(message);
      });
  } else {
    response.sendStatus(400);
  }
});

app.listen(PORT, () => {
  console.log(`Server is listening at port ${PORT}...`);
});
