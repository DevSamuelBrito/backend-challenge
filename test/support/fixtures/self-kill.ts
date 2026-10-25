import { ProcessKillFaultInjector } from "../../../src/shared/infrastructure/system/process-kill-fault-injector";

process.on("exit", () => console.log("handler de exit rodou"));
process.on("SIGTERM", () => console.log("handler de SIGTERM rodou"));

const injector = new ProcessKillFaultInjector("consumer.after_commit_before_ack");
await injector.check("outbox.after_send_before_mark");
console.log("passou pelo ponto que não é o configurado");
await injector.check("consumer.after_commit_before_ack");
console.log("código depois do ponto (não deveria aparecer)");
