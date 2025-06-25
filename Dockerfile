# 使用官方 Deno 镜像
FROM denoland/deno:latest

# 设置工作目录
WORKDIR /app

# 复制代码到容器
COPY src/ ./

RUN deno cache main.ts


# 启动开发模式（监听文件变化）
CMD ["deno", "run", "--watch", "--allow-net", "--allow-sys", "--allow-env", "--allow-read", "--allow-write", "main.ts"]
