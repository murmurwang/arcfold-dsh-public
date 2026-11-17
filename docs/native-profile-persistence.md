# 原生设置刷新后的运行配置

0.5.2 的隔离验收发现：用户已确认原生模型途径，模型列表也可见，但首次发送时 Arcfold 服务不可用。保存的同意记录存在，DSH 持久配置却没有运行设置；状态仍报告就绪。

`activateNativeDesktop` 原先调用所属树的 `update`。对于来自 profile 的条目，DSH 的 Include 只更新当前运行配置；下次重新组合 profile 时，未写入文件的设置被撤回。修补后由 DSH `configEditor.edit` 保存运行设置，由 `pluginManager.setPluginEnabled` 停用归属明确的旧连接。写入前核对归属，配置保存回调在 DSH 锁内再次核对当前内容；已持久保存且仍匹配时不重复激活。

`createNativeDesktopSetup` 的状态查询同时核对当前服务是否存在。服务丢失时返回启动失败状态，不再将首次启动成功永久当成可用；原同意记录和数据保留。提供商密钥、模型目录和默认选择仍归 DSH 管理。

`test/native-profile-persistence.test.mjs` 使用真实 DSH 加载、配置编辑、插件管理和刷新实现，验证原内存写入方式会丢失配置，修补后配置与旧连接停用可跨刷新及独立进程重启保留。业务组件在此检查中是最小替身；完整聊天、界面和最终原包的隔离验收另行执行，不能用这个测试代替。

原网页启动报告只记录了导入失败汇总。实际测试账户在业务服务缺失时仍能重新加载网页，尚不能认定两种失败同源。该观察保留为发行核对项，后续诊断与验收只按实际结果登记。

开发候选在原版 DSH 0.2.2-rc.1 的另一份全新资料中完成了自动预检：按包名安装后完成首次设置，首条消息选择 Pro；通过原生模型设置实际改写配置后，运行服务和网页插件仍可用；第二轮选择 Flash。两轮各自的归因、主回答、学习共六次请求均到达本机合成服务，任务提交成功且模型与来源选择一致。完全退出应用并重新启动后，原对话、目标、设置和调用记录能读回，没有增加模型请求。此预检使用开发账户的独立目录，不代替最终发行包在普通账户中的隔离验收，也不证明真实模型效果。

项目规定的隔离测试入口通过 1,098 项检查，无失败或跳过；工作流检查通过 33 项。另保留两类预检纠正记录：最初直接运行测试时未提供规定环境，随后改用完整隔离入口；旧合成服务仍返回先前的学习格式，随后按当前实际协议修正并从另一份全新资料重跑。修正测试夹具没有改写原失败记录。

0.5.3 的普通账户验收补充发现：0.4.1 通过所属 Include 动态创建的旧连接可写入该 Include 的基础文件，但不属于原生插件管理所寻址的 profile patch 条目，因此被报为 `unaddressable`。0.5.4 对此只开放一条兼容路径：必须有已验证的旧 Desktop 配置、唯一的原连接标识和模块、与业务条目相同的所属位置，而且配置补丁中没有对应条目或覆盖；在 DSH 的刷新互斥操作中重新核对后，通过原树停用、等待保存，并确认连接已停止。其他连接仍走原生管理入口，任何不确定归属或停用失败都中止。

新增回归用真实 DSH 动态创建连接，检查它确实不能由插件管理寻址，再验证停用结果和业务配置跨重新组合及独立进程重启保留。这个配置检查不替代实际旧版安装包的升级、首条消息、刷新和重启预检。

0.5.4 开发预检另复现了升级确认后的界面失败：原设置页面在打开工作区后强制整页重载，此时 DSH 正在替换客户端资源；现场旧资源地址返回 404，当前地址返回 200，启动检查发生在组件恢复完成前。设置流程现保留 DSH 页面，通过原生工作区导航后调用本界面插件的 `ctx.fiber.restart()`，由 Cordis 清理原设置组件、重新读取状态并等待新界面注册完成。失败继续上报，不更改 DSH 的启动检查。`test/native-ui-transition.test.mjs` 使用真实 Cordis 生命周期和设置组件验证切换、等待、失败与其他插件保留；实际旧包升级仍须单独预检。

## 0.5.4 本候选的实际 Desktop 开发预检回执

以下回执来自 2026-11-17 已完成的实际原版 Desktop 演练，测试的是提交 `26b13adf22cbf911ee9790446b5a42e475631306` 构建的两份归档。它不是配置替身或 UI 单元测试的结果。首次审阅未收到仓库外的这份材料，因而将安装、对话、数据及更新四项列为未知；本次只补充这四项的证据，不修改产品代码或决定。advisory 已单独登记为 #40。

实际流程包含 0.4.1 原包安装、保存旧会话及目标、模拟下载失败后恢复原包、重新安装 0.5.4、一次确认启用、三个自定义模型连接、原生配置刷新和正常退出重启；另一份全新资料完成首次安装、两次聊天选模、设置刷新和重启。所有模型请求均为本机合成响应。升级前的目标与轮次按 ID 核对，后续新会话不覆盖原始记录。

每个来源轮次均核对归因、主回答、学习任务已经提交、实际调用收到响应，以及其提供商、模型和思考等级与该轮选择一致。第一次打开新工作区仍为原默认灵眸 Claude / High；手动选择其他模型后，重启保留 DSH 保存的最后一次选择。

此文档不是打包输入。补证据时已逐个核对 417 份当前打包源文件与被测构建清单的 SHA-256 一致；回执按归档和源文件清单绑定。产品源码或包哈希一旦改变，不能据本回执声称新包已验收。GitHub 仍对新的文档提交运行完整检查。

预检中的夹具失败没有删除：第一份资料过早设置原生默认模型，导致旧版基线无法发出请求；第二份资料的旧凭据状态不匹配合成服务，通过测试 DSH 保存本次合成值后重跑成功。另有错误地要求所有模型支持 High 的等待，以及按同名目标数量核对的断言；前者在发消息前纠正，后者发生在正常退出后，改按原始 ID 和来源核对。最终回执来自上述实际完成的流程，不用失败或未知观察填充通过项。

```json
{
  "schema": "arcfold-native-upgrade-development-preflight-v1",
  "status": "pass",
  "observedDateUTC": "2026-11-17",
  "testedSource": "26b13adf22cbf911ee9790446b5a42e475631306",
  "environment": {
    "dsh": "0.2.2-rc.1",
    "platform": "darwin-arm64",
    "account": "development-account-separate-profiles",
    "ordinaryAccountAcceptance": false,
    "applicationArchiveSha256": "f21d83abfb33d463822a52c439cc9b15c8245dbce4ae4cf9424c90eae8eba94f",
    "interaction": "Actual signed Desktop app, native plugin install/update/model settings/chat controls, CDP observations",
    "modelService": "loopback synthetic only",
    "realProviderRequests": 0
  },
  "packages": {
    "@arcfold/dsh": "d7545f54ca50849d561f99fc44b62512a87b26f1a002d95a2886916b3e58adfc",
    "@arcfold/dsh-method-ui": "ee40dd37456f0de5038e331e5a97c9ce57c729e7901c6787a6158b1bee538bb9"
  },
  "sourceInputs": {
    "fileCount": 417,
    "allCurrentSourceFilesMatchTestedBuildInputs": true,
    "manifestSha256": "06207e94140fe9c867e190279971fb56f5ed6cdd50f43fe8d57b4a86654377c3",
    "inventorySha256": "656d084b49cfb5bde1b5c16eb6b0d9d589498c1a0775c22deecf0f3c00bd8064",
    "evidenceDocumentIsNotABuildInput": true
  },
  "upgrade": {
    "older": "0.4.1",
    "newer": "0.5.4",
    "checks": {
      "fresh_install": "pass",
      "synthetic_dialogue": "pass",
      "failed_download_restored": "pass",
      "confirmed_update": "pass",
      "restart_readback": "pass",
      "github_source_version_section": "unknown"
    },
    "downloadFailures": [
      {
        "event": "download-failed",
        "package": "@arcfold/dsh@0.5.4",
        "at": "2026-11-17T09:53:34.742Z"
      },
      {
        "event": "download-failed",
        "package": "@arcfold/dsh@0.5.4",
        "at": "2026-11-17T09:53:44.748Z"
      },
      {
        "event": "download-failed",
        "package": "@arcfold/dsh@0.5.4",
        "at": "2026-11-17T09:54:44.754Z"
      }
    ],
    "rollback": {
      "version": "0.4.1",
      "packagesVerifiedAgainstExactArchives": true,
      "oldConversationRendered": true
    },
    "transition": {
      "beforeState": "needs_upgrade",
      "afterState": "ready",
      "samePageTimeOrigin": true,
      "webState": {
        "status": 2,
        "importError": null,
        "reconciliation": {
          "syncing": false,
          "failures": []
        }
      },
      "workspaceNavigationObserved": true
    },
    "originalData": {
      "goal": {
        "id": "c4a95ca0-f4f9-4c37-a266-435246922d6c",
        "name": "核对 Arcfold 更新是否保留测试目标",
        "parentId": "35c19d2a-00df-4821-a550-e0216299904b"
      },
      "turns": [
        {
          "id": "5f0d95a597503e0569c7627b8f83fe24f53906fedcd9ae478f08e98d69dbca97",
          "sessionId": "session-e7e75101-18df-42ca-9ad3-1dce991e1dc2",
          "nativeTurn": 2,
          "sourceHash": "b50d9a5c94b3de600f9fd8a766d17573eaf9242522aedc6bb55c0889c361959f"
        }
      ],
      "sameOriginalIdsAndSourceHashesAfterUpgradeAndRestart": true,
      "legacyLedgerSameDeviceAndInodeAsInitialization": true,
      "legacyLedgerRequestsReadableAfterUpgrade": 5
    },
    "nativeCalls": [
      {
        "turnId": "cbbdf4b0acafe53bfbdb997546287c4d99fa1cd3c7e45deefa6311dcfe3f728f",
        "model": {
          "provider": "lmu-claude",
          "model": "claude-opus-5-5",
          "reasoningEffort": "high"
        },
        "stages": [
          {
            "jobId": "2f9b87fe037d55fdef1efcc89d91d731d552a38a63b521bb7cabc3f0cb405f6c",
            "role": "attribution",
            "status": "committed",
            "model": {
              "provider": "lmu-claude",
              "model": "claude-opus-5-5",
              "reasoningEffort": "high"
            },
            "invocations": [
              {
                "id": "02eeb08b82cc69363a23e46dec84a496576eaee0d4745b3de9e46e357dace3a3",
                "status": "response_received",
                "model": {
                  "provider": "lmu-claude",
                  "model": "claude-opus-5-5",
                  "reasoningEffort": "high"
                }
              }
            ]
          },
          {
            "jobId": "d78529893ef9988e2021d8860332ae709417b16ccc1dc1b36e3643e13d19b186",
            "role": "main",
            "status": "committed",
            "model": {
              "provider": "lmu-claude",
              "model": "claude-opus-5-5",
              "reasoningEffort": "high"
            },
            "invocations": [
              {
                "id": "1ed49d558f055db5f8325f1e3ca697b06758f8aa9571fc36f678fb9d5d625534",
                "status": "response_received",
                "model": {
                  "provider": "lmu-claude",
                  "model": "claude-opus-5-5",
                  "reasoningEffort": "high"
                }
              }
            ]
          },
          {
            "jobId": "704466917f84df0b554f562bc9f75119f24b66b9b0ab9dd3d066e8d671768282",
            "role": "learning",
            "status": "committed",
            "model": {
              "provider": "lmu-claude",
              "model": "claude-opus-5-5",
              "reasoningEffort": "high"
            },
            "invocations": [
              {
                "id": "e467be5bce5ff28af45b9960d5c0490213dc49cb30c0070a719ccb64c5db192a",
                "status": "response_received",
                "model": {
                  "provider": "lmu-claude",
                  "model": "claude-opus-5-5",
                  "reasoningEffort": "high"
                }
              }
            ]
          }
        ]
      },
      {
        "turnId": "126b7d22781f12eea7f95d6a2e36c184ad7f04fefbd6721c2b7ac5714203fd3e",
        "model": {
          "provider": "anthropic",
          "model": "claude-fable-5-2",
          "reasoningEffort": null
        },
        "stages": [
          {
            "jobId": "866048f4463c17d9ce5b302034c222e2cb3d8b01ad9c332301a983a0a04c3838",
            "role": "attribution",
            "status": "committed",
            "model": {
              "provider": "anthropic",
              "model": "claude-fable-5-2",
              "reasoningEffort": null
            },
            "invocations": [
              {
                "id": "77661ab9ecb26c0d10c2520662993aa86d643649c97c8fab5608c51f11fd5bb4",
                "status": "response_received",
                "model": {
                  "provider": "anthropic",
                  "model": "claude-fable-5-2",
                  "reasoningEffort": null
                }
              }
            ]
          },
          {
            "jobId": "37db0b7c180b63a6ab840141aaeffe664d996fb24627953527ba3505e11dd88e",
            "role": "main",
            "status": "committed",
            "model": {
              "provider": "anthropic",
              "model": "claude-fable-5-2",
              "reasoningEffort": null
            },
            "invocations": [
              {
                "id": "d8d3304c2f50320ad5a4ea401a3a977cd5c9730a5e7a3d971789a26f3490c615",
                "status": "response_received",
                "model": {
                  "provider": "anthropic",
                  "model": "claude-fable-5-2",
                  "reasoningEffort": null
                }
              }
            ]
          },
          {
            "jobId": "ffc715d53a2b5e29081aefe7993ec2d3572cd9da73d4f04359e88bc332073fb5",
            "role": "learning",
            "status": "committed",
            "model": {
              "provider": "anthropic",
              "model": "claude-fable-5-2",
              "reasoningEffort": null
            },
            "invocations": [
              {
                "id": "067db379b15876a0e84f831f256019150f1e2c9529d68459bbdfe3c5f1f22e17",
                "status": "response_received",
                "model": {
                  "provider": "anthropic",
                  "model": "claude-fable-5-2",
                  "reasoningEffort": null
                }
              }
            ]
          }
        ]
      },
      {
        "turnId": "093407ed6d7002817406ccfaea6bbd7ab4a189cd860f306952dcff276b8a92e1",
        "model": {
          "provider": "openai",
          "model": "gpt-6-astra",
          "reasoningEffort": null
        },
        "stages": [
          {
            "jobId": "e8541cb2d0ae8ecad6317af4a197e7b10df3b19cfe727f4a6bb6d0cb09816c4d",
            "role": "attribution",
            "status": "committed",
            "model": {
              "provider": "openai",
              "model": "gpt-6-astra",
              "reasoningEffort": null
            },
            "invocations": [
              {
                "id": "3ee18e623d56088a5ea40c00b15192c8a8847cd9cf8bc940ddaf6cd73ab28729",
                "status": "response_received",
                "model": {
                  "provider": "openai",
                  "model": "gpt-6-astra",
                  "reasoningEffort": null
                }
              }
            ]
          },
          {
            "jobId": "55fc184932f482a905b6fe9f7785aa85643f00067b12f016488c5dfb0a05adfd",
            "role": "main",
            "status": "committed",
            "model": {
              "provider": "openai",
              "model": "gpt-6-astra",
              "reasoningEffort": null
            },
            "invocations": [
              {
                "id": "fc016a2582d1c412eb1f68bf2de070fc3f075b552398fa846ef5c250ac33a6cb",
                "status": "response_received",
                "model": {
                  "provider": "openai",
                  "model": "gpt-6-astra",
                  "reasoningEffort": null
                }
              }
            ]
          },
          {
            "jobId": "9dea66a1fd0b457ea10e6ac659dbd7966dc8c31cdae4774c4cbacb2cbe2e364c",
            "role": "learning",
            "status": "committed",
            "model": {
              "provider": "openai",
              "model": "gpt-6-astra",
              "reasoningEffort": null
            },
            "invocations": [
              {
                "id": "9d978d54a435bed20b02c512dde751e8a61cc7a659f9534d6323939b6e9b87f3",
                "status": "response_received",
                "model": {
                  "provider": "openai",
                  "model": "gpt-6-astra",
                  "reasoningEffort": null
                }
              }
            ]
          }
        ]
      }
    ],
    "configRefresh": {
      "operation": "Changed only the test lmu-claude loopback URL trailing slash in native Models settings",
      "setupState": "ready",
      "web": {
        "status": 2,
        "importError": null,
        "reconciliation": {
          "syncing": false,
          "failures": []
        }
      }
    },
    "restart": {
      "normalExitAndRelaunch": true,
      "setupState": "ready",
      "web": {
        "status": 2,
        "importError": null,
        "reconciliation": {
          "syncing": false,
          "failures": []
        }
      },
      "sameTurnJobAndInvocationRecords": true,
      "modelRequestsBefore": 12,
      "modelRequestsAfter": 12
    },
    "dailyShape": {
      "plugins": "Exact local test copy of the observed provider-independent thinking-replay plugin",
      "guardSha256": "55ec42473279dfb54816d3cf6099b3de8efd6a45573b547ded9075c4d48e43ce",
      "threeModelIds": {
        "anthropic": "claude-fable-5-2",
        "openai": "gpt-6-astra",
        "lmu-claude": "claude-opus-5-5"
      },
      "lmuReasoningLevelsPreserved": true,
      "firstNewWorkspaceSelection": {
        "provider": "lmu-claude",
        "model": "claude-opus-5-5",
        "reasoningEffort": "high"
      },
      "afterExplicitChatSelectionsAndRestart": {
        "provider": "openai",
        "model": "gpt-6-astra"
      },
      "secretValuesRead": false
    }
  },
  "freshInstall": {
    "receiptHasNoPreviousLegacyConfiguration": true,
    "actualInstallSetupAndFirstMessage": "pass",
    "nativeCalls": [
      {
        "turnId": "802bd9efb2d66998c81fb9020e22e67a4fb1176d47e64c7c3663421355a0afc3",
        "model": {
          "provider": "deepseek-official",
          "model": "deepseek-v4-pro",
          "reasoningEffort": "high"
        },
        "stages": [
          {
            "jobId": "7d14a7033030f01c14e7ed9b3a574d2a05150cf9d530d844eb38bd8159615ebe",
            "role": "attribution",
            "status": "committed",
            "model": {
              "provider": "deepseek-official",
              "model": "deepseek-v4-pro",
              "reasoningEffort": "high"
            },
            "invocations": [
              {
                "id": "02756e61d189e4b4c3330a4f9f9642d6ed9593f9a52f3915940ec9a9ea431f73",
                "status": "response_received",
                "model": {
                  "provider": "deepseek-official",
                  "model": "deepseek-v4-pro",
                  "reasoningEffort": "high"
                }
              }
            ]
          },
          {
            "jobId": "989b82aa551aa6146cbb2ed6a00f8b6eaad0d1c369b27cad66ab3784581f690f",
            "role": "main",
            "status": "committed",
            "model": {
              "provider": "deepseek-official",
              "model": "deepseek-v4-pro",
              "reasoningEffort": "high"
            },
            "invocations": [
              {
                "id": "73b37d93521a04fb58feb61a7816a63c2686ab2cae44238afd9ad4a8d07d98dd",
                "status": "response_received",
                "model": {
                  "provider": "deepseek-official",
                  "model": "deepseek-v4-pro",
                  "reasoningEffort": "high"
                }
              }
            ]
          },
          {
            "jobId": "4852c96fa04c0acfa6996c51094fad27c201e2c2d162af3e7972c262faa0f710",
            "role": "learning",
            "status": "committed",
            "model": {
              "provider": "deepseek-official",
              "model": "deepseek-v4-pro",
              "reasoningEffort": "high"
            },
            "invocations": [
              {
                "id": "807e498dd27ee3335a441754b38d16c6bde32b13ea6925a21dc6ca346be8d254",
                "status": "response_received",
                "model": {
                  "provider": "deepseek-official",
                  "model": "deepseek-v4-pro",
                  "reasoningEffort": "high"
                }
              }
            ]
          }
        ]
      },
      {
        "turnId": "583070d5414871e67e5c42ae150ee9c152fa8dc600d30efd81c8c5e8238ac524",
        "model": {
          "provider": "deepseek-official",
          "model": "deepseek-flash",
          "reasoningEffort": "high"
        },
        "stages": [
          {
            "jobId": "1deff49b98676a60ef5d7d225c5e57e5f845de8646e9511d895fce8bd9c9de6b",
            "role": "attribution",
            "status": "committed",
            "model": {
              "provider": "deepseek-official",
              "model": "deepseek-flash",
              "reasoningEffort": "high"
            },
            "invocations": [
              {
                "id": "d66e363146c85074973c5a85d786733c752b6d0013c6071dcc8a72f8f588de1f",
                "status": "response_received",
                "model": {
                  "provider": "deepseek-official",
                  "model": "deepseek-flash",
                  "reasoningEffort": "high"
                }
              }
            ]
          },
          {
            "jobId": "1db5ad86de4f5d347ac27094071e581aaae0e77ae6fb89a47d45ed8457c95c68",
            "role": "main",
            "status": "committed",
            "model": {
              "provider": "deepseek-official",
              "model": "deepseek-flash",
              "reasoningEffort": "high"
            },
            "invocations": [
              {
                "id": "a51b66830fcc3a5c6e9d9b62c8569bf9debad3d0d2b70c1a69db46a2c5c05b7d",
                "status": "response_received",
                "model": {
                  "provider": "deepseek-official",
                  "model": "deepseek-flash",
                  "reasoningEffort": "high"
                }
              }
            ]
          },
          {
            "jobId": "e3d2881f16266d447f7bd89cddfa4e8fd30d694f2aacb1d2f1d0a34dbc5bbc25",
            "role": "learning",
            "status": "committed",
            "model": {
              "provider": "deepseek-official",
              "model": "deepseek-flash",
              "reasoningEffort": "high"
            },
            "invocations": [
              {
                "id": "a7ff1771e86825ce5ba76bd033fed79e37dd4f83b16aaec1e7486af44dac8e9d",
                "status": "response_received",
                "model": {
                  "provider": "deepseek-official",
                  "model": "deepseek-flash",
                  "reasoningEffort": "high"
                }
              }
            ]
          }
        ]
      }
    ],
    "configRefresh": "pass",
    "normalExitAndRelaunch": "pass",
    "sameSourceAndInvocationRecords": true,
    "modelRequestsBefore": 6,
    "modelRequestsAfter": 6,
    "web": {
      "status": 2,
      "importError": null,
      "reconciliation": {
        "syncing": false,
        "failures": []
      }
    }
  },
  "evidenceSha256": {
    "preflight-summary.json": "affe542d3082e86dc8f5857164f42601bd12fe684561203f958edc7a31f2440d",
    "profile-shape-readback.json": "ceafd0afbd904f6df64d1ecc93fe5c6dbd27f127b54e2720434c8998d10beb05",
    "preflight-ui-2/10-before-native-enable.json": "28ba6b76efdc0e7584911061b0bd22aa69ce9d25bfa8c5057247e42ac5e357b1",
    "preflight-ui-2/11b-transition-complete.json": "4c37801d949763fcfae743d754fbc621c9e69fa2cd80c6882f49121d58d7c571",
    "preflight-ui-2/14-native-three-models.json": "79b569b72d189494f4b2390e74d2270914af0639e36bb9cc79e17f7dbf0ccd07",
    "preflight-ui-2/16-config-refresh-ready.json": "8ea83ffeb9346932afeb434ece0686d599e78d21e9d04383b62263543237d8dc",
    "preflight-ui-2/17-upgrade-restart-readback.json": "b6d8d060cc516d19262792ee94ef90b92e6b6d7b5a41385d5a84c9f34d09bfe2",
    "preflight-profile-2-evidence/restored.json": "009077394781f79cc34e1eb875dc616c3dc5b5b3609e262357de2efc532470ed",
    "preflight-profile-2-evidence/result.json": "740f87cabee0b55fecf735a705630dae5c28ae6712eecb987a2c8fa567b4cbee",
    "preflight-profile-2-evidence/native-result.json": "67fb1a1823814a63f2d0d396fa8adc6e5f3fd12b12cb21b4ae8b2d6cddec0779",
    "preflight-profile-2-evidence/native-readback.json": "724c17435b78010e68ac8dc5f952c106497bfceb6a100408c4d173c22693d391"
  },
  "limits": [
    "Development preflight; final merged packages still require two matching builds and ordinary-account acceptance before publication.",
    "Synthetic local responses do not validate real credentials, network availability or model output quality.",
    "Local raw screenshots and diagnostics remain private; this is an allowlisted projection of synthetic observations."
  ]
}
```
