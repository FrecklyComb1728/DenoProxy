# DenoProxy 代理服务

[NodeProxy](https://github.com/FrecklyComb1728/NodeProxy)的Deno版本实现，保留了原项目的核心功能。

## 功能特点

- 多源CDN代理支持
- 高性能内存缓存系统
- 实时监控与状态展示
- 可配置的反向代理规则
- 路径别名支持，一个代理可以通过多个路径访问
- 静态资源服务器
- 丰富的前端界面

## 使用方法

### 运行

```bash
# 直接运行
deno run --allow-net --allow-read --allow-env main.ts

# 或者使用deno.json的tasks
deno task start

```

### 配置

配置文件位于`index_config.json`，主要配置项包括:

什么！你不知道怎么配置？请看[这里](https://github.com/FrecklyComb1728/NodeProxy/blob/main/docs/config.md)

```json
{
    "title": "服务名称",
    "description": "服务描述",
    "footer": "页脚信息",
    "establishTime": "建站时间",
    "host": "监听主机",
    "port": "端口号",
    "cache": {
        "enabled": true,
        "type": "memory",
        "minSize": "2MB",
        "maxTime": "2678400S",
        "maxSize": "1024MB"
    },
    "proxies": [
        {
            "prefix": "/prefix/",
            "aliases": ["/alias1/", "/alias2/"],
            "target": "https://target.com/path/",
            "description": "代理说明"
        }
    ]
}
```

## 相比NodeProxy版本的区别

1. 使用Deno运行时而非Node.js
2. 采用TypeScript开发，类型安全
3. 只实现内存缓存，移除了磁盘缓存
4. 简化了代理实现，移除了Worker线程

## 路径别名

路径别名功能允许你为一个代理配置多个访问路径。在代理配置中添加`aliases`数组：

```json
{
  "prefix": "/oss/",
  "aliases": ["/img/", "/images/"],
  "target": "https://your-cdn-url.com/path/"
}
```

通过这种方式，不仅可以通过`/oss/image.png`访问图片，还可以使用`/img/image.png`或`/images/image.png`访问相同的资源。

别名匹配的优先级低于主前缀(prefix)，所以如果有冲突，会优先匹配主前缀。

## 许可证

MIT License 
