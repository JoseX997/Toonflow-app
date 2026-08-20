type ImageModel = {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
};

type ImageConfig = {
  prompt: string;
  referenceList?: { type: "image"; sourceType: "base64"; base64: string }[];
  size: "1K" | "2K" | "4K";
  aspectRatio: string;
};

declare const axios: any;
declare const FormData: any;
declare const urlToBase64: (url: string) => Promise<string>;
declare const exports: {
  vendor: any;
  textRequest: (...args: any[]) => any;
  imageRequest: (config: ImageConfig, model: ImageModel) => Promise<string>;
  videoRequest: (...args: any[]) => Promise<string>;
  ttsRequest: (...args: any[]) => Promise<string>;
  checkForUpdates: () => Promise<any>;
  updateVendor: () => Promise<string>;
};

const vendor = {
  id: "user-ominiapi",
  version: "1.0.0",
  name: "OminiAPI",
  author: "User",
  description: "OminiAPI OpenAI-compatible image generation",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true, placeholder: "API Key" },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "https://www.ominiapi.com/v1" }
  ],
  inputValues: {
    apiKey: "",
    baseUrl: "https://www.ominiapi.com/v1"
  },
  models: [
    { name: "GPT Image 2", modelName: "gpt-image-2", type: "image", mode: ["text", "singleImage", "multiReference"] }
  ]
};

const extractImage = async (response: any): Promise<string> => {
  const item = response && response.data && response.data.data && response.data.data[0];
  if (item && item.b64_json) return "data:image/png;base64," + item.b64_json;
  if (item && item.url) return await urlToBase64(item.url);
  throw new Error("图片接口未返回 url 或 b64_json");
};

const getImagePart = async (dataUri: string, index: number) => {
  const match = String(dataUri || "").match(/^data:([^;,]+);base64,/i);
  if (!match) throw new Error("第 " + (index + 1) + " 张参考图不是有效的 base64 data URI");
  const response = await axios.get(dataUri, { responseType: "arraybuffer" });
  const mime = match[1] || "image/png";
  const extension = mime.split("/")[1] || "png";
  return { data: response.data, mime, filename: "reference-" + (index + 1) + "." + extension };
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  const apiKey = String(vendor.inputValues.apiKey || "").replace(/^Bearer\s+/i, "");
  if (!apiKey) throw new Error("缺少 API Key");

  const baseUrl = String(vendor.inputValues.baseUrl || "").replace(/\/+$/, "");
  const ratio = String(config.aspectRatio || "1:1").split(":").map(Number);
  const size = ratio[0] > ratio[1] ? "1536x1024" : ratio[0] < ratio[1] ? "1024x1536" : "1024x1024";
  const references = (config.referenceList || []).filter((item) => item && item.type === "image" && item.base64);

  if (references.length > 0) {
    const form = new FormData();
    form.append("model", model.modelName);
    form.append("prompt", config.prompt);
    form.append("size", size);
    form.append("n", "1");
    form.append("response_format", "b64_json");

    const imageField = references.length > 1 ? "image[]" : "image";
    for (let index = 0; index < references.length; index += 1) {
      const part = await getImagePart(references[index].base64, index);
      form.append(imageField, part.data, { filename: part.filename, contentType: part.mime });
    }

    const response = await axios.post(baseUrl + "/images/edits", form, {
      headers: { Authorization: "Bearer " + apiKey, ...form.getHeaders() },
      maxBodyLength: Infinity,
      timeout: 300000
    });
    return await extractImage(response);
  }

  const response = await axios.post(baseUrl + "/images/generations", {
    model: model.modelName,
    prompt: config.prompt,
    size: size,
    n: 1,
    response_format: "b64_json"
  }, {
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    timeout: 300000
  });
  return await extractImage(response);
};

exports.vendor = vendor;
exports.textRequest = () => null;
exports.imageRequest = imageRequest;
exports.videoRequest = async () => "";
exports.ttsRequest = async () => "";
exports.checkForUpdates = async () => ({ hasUpdate: false, latestVersion: "1.0.0", notice: "" });
exports.updateVendor = async () => "";
export { };
