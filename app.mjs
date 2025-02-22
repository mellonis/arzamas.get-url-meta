import express from 'express';
import * as cheerio from 'cheerio';

const PORT = Number(process.env.PORT || 3000);

const app = express();

app.get('/', ({query: {url: requestedUrl}}, response) => {
  if (!requestedUrl || !URL.canParse(requestedUrl)) {
    const error = {
      code: 400,
      message: 'Invalid requested',
    }

    console.error(error.code, error.message);

    response.status(error.code).end(error.message);

    return;
  }

  console.log(requestedUrl);

  fetch(requestedUrl)
    .then((response) => {
      if (!response.ok) {
        throw {code: response.status, message: response.statusText};
      }

      return response.text();
    })
    .then((body) => {
      const $ = cheerio.load(body);
      const $title = $('head > title');
      const $description = $('meta[name="description"]');

      return {
        title: $title && $title.text().trim() || '',
        description: $description && $description.attr('content') && $description.attr('content').trim() || '',
      };
    })
    .then((data) => {
      console.log(data);

      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.end(JSON.stringify(data));
    })
    .catch((error = {}) => {
      const {code = 500, message = 'Server error'} = error;

      console.error(code, message);

      response.statusCode = code;
      response.status(code).end(message);
    });
});

app.listen(PORT, () => {
  console.log(`Server is listening at port ${PORT}...`);
});
