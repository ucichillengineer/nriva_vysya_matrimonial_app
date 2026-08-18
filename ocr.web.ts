import { recognize } from 'tesseract.js';

export async function recognizeImage(file: File, onProgress: (percent: number) => void) {
  const result = await recognize(file, 'eng', {
    logger: (message) => {
      if (message.status === 'recognizing text') onProgress(Math.round(message.progress * 100));
    },
  });
  return result.data.text;
}
