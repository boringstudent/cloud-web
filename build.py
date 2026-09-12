import os
import shutil
import time

STORAGE_REPO = os.environ.get('CLOUD', 'boringstudent/new-cloud')
REPO_OWNER = STORAGE_REPO.split('/')[0]
REPO_NAME = STORAGE_REPO.split('/')[1] if '/' in STORAGE_REPO else STORAGE_REPO
DEFAULT_BRANCH = os.environ.get('BRANCH', 'main')


def copy_static_files(output_dir):
    for filename in ['favicon.ico', 'CNAME', 'config.json']:
        src = os.path.join('.', filename)
        dst = os.path.join(output_dir, filename)
        if os.path.exists(src):
            shutil.copy2(src, dst)
    static_src = os.path.join('.', 'static')
    if os.path.isdir(static_src):
        shutil.copytree(static_src, os.path.join(output_dir, 'static'))


if __name__ == "__main__":
    output_dir = 'build'

    if os.path.exists(output_dir):
        shutil.rmtree(output_dir)
    os.makedirs(output_dir, exist_ok=True)

    copy_static_files(output_dir)

    with open('template.html', 'r', encoding='utf-8') as f:
        template = f.read()

    # Cache-busting version for static assets, identical for both pages in one build
    version = str(int(time.time()))

    for out_name, title in [('index.html', 'Home'), ('404.html', '404 - 页面未找到')]:
        content = template.format(
            title=title,
            repo_owner=REPO_OWNER,
            repo_name=REPO_NAME,
            default_branch=DEFAULT_BRANCH,
            version=version
        )
        with open(os.path.join(output_dir, out_name), 'w', encoding='utf-8') as f:
            f.write(content)

    # Keep the repository-root 404.html in sync with the template source
    shutil.copyfile('template.html', '404.html')

    print(f'Build completed. Storage repo: {REPO_OWNER}/{REPO_NAME}, version: {version}')
