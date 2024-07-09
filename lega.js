#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Command } = require("commander");
const ftpClient = require("ftp");
const dotenv = require("dotenv");
const readline = require("readline");
const { exec } = require("child_process");

dotenv.config();

const program = new Command();

const replicateStructure = (srcDir, destDir) => {
  fs.readdirSync(srcDir, { withFileTypes: true }).forEach((entry) => {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(destPath, { recursive: true });
      }
      replicateStructure(srcPath, destPath);
    }
  });
};

program
  .command("create <updateDir>")
  .description("Create an update directory with old and new folders")
  .action((updateDir) => {
    const fullPath = path.resolve(process.cwd(), updateDir);
    const oldDir = path.join(fullPath, "old");
    const newDir = path.join(fullPath, "new");

    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
    if (!fs.existsSync(oldDir)) {
      fs.mkdirSync(oldDir, { recursive: true });
    }
    if (!fs.existsSync(newDir)) {
      fs.mkdirSync(newDir, { recursive: true });
    }

    console.log(`Update directory ${updateDir} created successfully.`);
  });

program
  .command("add <updateDir> <filePath>")
  .description("Add a file to the update directory")
  .action((updateDir, filePath) => {
    const fullPath = path.resolve(process.cwd(), updateDir);
    const oldDir = path.join(fullPath, "old");
    const newDir = path.join(fullPath, "new");
    const relPath = path.relative(process.cwd(), filePath);
    const destOldPath = path.join(oldDir, relPath);
    const destNewPath = path.join(newDir, relPath);

    fs.mkdirSync(path.dirname(destOldPath), { recursive: true });
    fs.mkdirSync(path.dirname(destNewPath), { recursive: true });

    fs.copyFileSync(filePath, destOldPath);
    fs.copyFileSync(filePath, destNewPath);

    console.log(`File ${filePath} added to update directory ${updateDir}.`);

    openInVSCode(destNewPath);
  });

function openInVSCode(filePath) {
  const command = `code --add "${filePath}"`;
  exec(command, (err, stdout, stderr) => {
    if (err) {
      console.error(`Error opening file in VS Code: ${err.message}`);
      return;
    }
    if (stderr) {
      console.error(`Error opening file in VS Code: ${stderr}`);
      return;
    }
    console.log(`File ${filePath} added to the current VS Code window.`);
  });
}

// Function to create a readline interface for prompting user input
function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

program
  .command("push <updateDir> <version>")
  .description("Load the specified version (old or new) to the FTP server")
  .action(async (updateDir, version) => {
    const ftpHost = process.env.FTP_HOST;
    const ftpUser = process.env.FTP_USER;
    const ftpPassword = process.env.FTP_PASSWORD;
    const remoteBaseDirectory = process.env.FTP_REMOTE_DIR;

    if (version !== "new" && version !== "old") {
      console.log("Please specify either 'old' or 'new' version.");
      return;
    }

    if (!ftpHost || !ftpUser || !ftpPassword || !remoteBaseDirectory) {
      console.log(
        "FTP credentials are not set. Please set them in the .env file."
      );
      return;
    }

    const client = new ftpClient();
    const rl = createInterface(); // Create readline interface

    client.on("ready", async () => {
      try {
        const fullPath = path.resolve(process.cwd(), updateDir);
        const srcDir = path.join(fullPath, version);

        const filesToUpload = await listFiles(srcDir); // List all files to be uploaded

        console.log("Files to be uploaded:");
        filesToUpload.forEach((file) => {
          console.log(`${file.localFilePath} -> ${file.remoteFilePath}`);
        });

        const confirm = await askConfirmation(
          rl,
          "Do you want to proceed? (y/n): "
        );

        if (confirm) {
          console.log("Confirmed.. starting..");
          for (const file of filesToUpload) {
            await uploadFile(client, file.localFilePath, file.remoteFilePath);
          }
          console.log("Upload completed successfully.");
        } else {
          console.log("Operation cancelled.");
        }
      } catch (err) {
        console.error(`Error during upload: ${err.message}`);
      } finally {
        rl.close(); // Close readline interface
        client.end();
      }
    });

    client.on("error", (err) => {
      console.error(`FTP client error: ${err.message}`);
      rl.close();
      client.end();
    });

    client.on("close", (hadError) => {
      if (hadError) {
        console.error("FTP client closed due to an error.");
      } else {
        console.log("FTP client closed successfully.");
      }
      rl.close();
    });

    client.connect({
      host: ftpHost,
      user: ftpUser,
      password: ftpPassword,
      connTimeout: 5000,
      pasvTimeout: 5000,
      keepalive: 5000,
      pasv: true,
    });
  });

// Function to list all files recursively in a directory
async function listFiles(dir) {
  const filesToUpload = [];

  const traverse = async (currentDir) => {
    const files = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const file of files) {
      const filePath = path.join(currentDir, file.name);

      if (file.isDirectory()) {
        await traverse(filePath); // Recursively traverse directories
      } else {
        // Prepare local and remote paths for files
        const localPath = filePath;
        const remotePath = path.join(
          process.env.FTP_REMOTE_DIR,
          path.relative(dir, filePath)
        );
        filesToUpload.push({
          localFilePath: localPath,
          remoteFilePath: remotePath,
        });
      }
    }
  };

  await traverse(dir);
  return filesToUpload;
}

// Function to prompt for user confirmation
function askConfirmation(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

async function uploadFile(client, localFilePath, remoteFilePath) {
  return new Promise((resolve, reject) => {
    client.put(localFilePath, remoteFilePath, (err) => {
      if (err) {
        reject(err);
      } else {
        console.log(`Uploaded ${localFilePath} to ${remoteFilePath}`);
        resolve();
      }
    });
  });
}

program
  .command("list <updateDir> <version>")
  .description("List all files in the specified version (old or new) directory")
  .action((updateDir, version) => {
    const fullPath = path.resolve(process.cwd(), updateDir);
    const versionDir = path.join(fullPath, version);

    if (!fs.existsSync(versionDir)) {
      console.error(
        `The specified version directory (${version}) does not exist.`
      );
      return;
    }

    const listFilesRecursively = (dir, fileList = []) => {
      fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          listFilesRecursively(entryPath, fileList);
        } else {
          fileList.push(entryPath);
        }
      });
      return fileList;
    };

    const files = listFilesRecursively(versionDir);
    if (files.length === 0) {
      console.log(`No files found in the ${version} directory.`);
    } else {
      console.log(`Files in the ${version} directory:`);
      files.forEach((file) => console.log(file));
    }
  });

program
  .command("remove <updateDir> <filePath>")
  .description("Remove a file from the update directory")
  .action((updateDir, filePath) => {
    const fullPath = path.resolve(process.cwd(), updateDir);
    const oldDir = path.join(fullPath, "old", filePath);
    const newDir = path.join(fullPath, "new", filePath);

    const removeFileIfExists = (file) => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        console.log(`Removed ${file}`);
      } else {
        console.log(`${file} does not exist.`);
      }
    };

    removeFileIfExists(oldDir);
    removeFileIfExists(newDir);
  });

program
  .command("compare <updateDir>")
  .description("Compare files between old and new directories")
  .action((updateDir) => {
    const fullPath = path.resolve(process.cwd(), updateDir);
    const oldDir = path.join(fullPath, "old");
    const newDir = path.join(fullPath, "new");

    const compareFilesRecursively = (oldPath, newPath) => {
      const oldFiles = fs.readdirSync(oldPath, { withFileTypes: true });
      const newFiles = fs.readdirSync(newPath, { withFileTypes: true });

      const oldFileNames = new Set(oldFiles.map((file) => file.name));
      const newFileNames = new Set(newFiles.map((file) => file.name));

      oldFiles.forEach((file) => {
        const oldFilePath = path.join(oldPath, file.name);
        const newFilePath = path.join(newPath, file.name);
        if (file.isDirectory()) {
          if (newFileNames.has(file.name)) {
            compareFilesRecursively(oldFilePath, newFilePath);
          } else {
            console.log(`Directory ${oldFilePath} is missing in new.`);
          }
        } else {
          if (!newFileNames.has(file.name)) {
            console.log(`File ${oldFilePath} is missing in new.`);
          } else {
            const oldFileContent = fs.readFileSync(oldFilePath);
            const newFileContent = fs.readFileSync(newFilePath);
            if (oldFileContent.toString() !== newFileContent.toString()) {
              console.log(`File ${file.name} differs between old and new.`);
            }
          }
        }
      });

      newFiles.forEach((file) => {
        if (!oldFileNames.has(file.name)) {
          console.log(
            `File ${path.join(newPath, file.name)} is missing in old.`
          );
        }
      });
    };

    compareFilesRecursively(oldDir, newDir);
  });

program
  .command("backup <updateDir>")
  .description("Backup the update directory")
  .action((updateDir) => {
    const fullPath = path.resolve(process.cwd(), updateDir);
    const backupDir = `${fullPath}_backup_${Date.now()}`;

    const copyDirectory = (src, dest) => {
      fs.mkdirSync(dest, { recursive: true });
      fs.readdirSync(src, { withFileTypes: true }).forEach((entry) => {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          copyDirectory(srcPath, destPath);
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      });
    };

    copyDirectory(fullPath, backupDir);
    console.log(`Backup created at ${backupDir}`);
  });

program
  .command("restore <updateDir> <backupDir>")
  .description("Restore the update directory from a backup")
  .action((updateDir, backupDir) => {
    const fullPath = path.resolve(process.cwd(), updateDir);
    const backupPath = path.resolve(process.cwd(), backupDir);

    if (!fs.existsSync(backupPath)) {
      console.error(`Backup directory ${backupDir} does not exist.`);
      return;
    }

    const deleteDirectory = (dir) => {
      if (fs.existsSync(dir)) {
        fs.readdirSync(dir).forEach((file) => {
          const curPath = path.join(dir, file);
          if (fs.lstatSync(curPath).isDirectory()) {
            deleteDirectory(curPath);
          } else {
            fs.unlinkSync(curPath);
          }
        });
        fs.rmdirSync(dir);
      }
    };

    deleteDirectory(fullPath);

    const copyDirectory = (src, dest) => {
      fs.mkdirSync(dest, { recursive: true });
      fs.readdirSync(src, { withFileTypes: true }).forEach((entry) => {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          copyDirectory(srcPath, destPath);
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      });
    };

    copyDirectory(backupPath, fullPath);
    console.log(`Restored ${updateDir} from backup ${backupDir}`);
  });

program
  .command("open <updateDir>")
  .description("Open all files in the new/ directory in VS Code")
  .action((updateDir) => {
    const fullPath = path.resolve(process.cwd(), updateDir);
    const newDir = path.join(fullPath, "new");

    if (!fs.existsSync(newDir)) {
      console.error(`The new directory does not exist in ${updateDir}.`);
      return;
    }

    const openFilesInVSCode = (dir) => {
      fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          openFilesInVSCode(entryPath); // Recursively open files in subdirectories
        } else {
          openInVSCode(entryPath); // Open file in VS Code
        }
      });
    };

    openFilesInVSCode(newDir);
  });

program.parse(process.argv);
