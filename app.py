from flask import Flask, render_template, request, flash, redirect, url_for

from config import config
from chat import chat_bp

app = Flask(__name__)
app.secret_key = config.flask_secret
app.config["MAX_CONTENT_LENGTH"] = (config.max_upload_mb + 1) * 1024 * 1024

app.register_blueprint(chat_bp)


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/about')
def about():
    return render_template('about.html')


@app.route('/contact', methods=['GET', 'POST'])
def contact():
    if request.method == 'POST':
        name = request.form.get('name', '').strip()
        email = request.form.get('email', '').strip()
        message = request.form.get('message', '').strip()

        if not name or not email or not message:
            flash('Пожалуйста, заполните все поля.', 'error')
        else:
            flash('Спасибо за ваше сообщение! Мы свяжемся с вами в ближайшее время.', 'success')
            return redirect(url_for('contact'))

    return render_template('contact.html')


if __name__ == '__main__':
    app.run(debug=config.flask_debug)
