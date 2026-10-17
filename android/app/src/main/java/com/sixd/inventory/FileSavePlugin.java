package com.sixd.inventory;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.io.OutputStream;

/**
 * Opens Android's "Save as" screen so the user chooses the folder and
 * the file name, then copies a temporary file there.
 */
@CapacitorPlugin(name = "FileSave")
public class FileSavePlugin extends Plugin {

    @PluginMethod
    public void saveFile(PluginCall call) {

        String sourceUri = call.getString("sourceUri");
        String fileName = call.getString("fileName");
        String mimeType = call.getString("mimeType", "application/zip");

        if (sourceUri == null || fileName == null) {
            call.reject("sourceUri and fileName are required.");
            return;
        }

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, fileName);

        startActivityForResult(call, intent, "handleSaveFile");
    }

    @ActivityCallback
    private void handleSaveFile(PluginCall call, ActivityResult result) {

        if (call == null) {
            return;
        }

        if (result.getResultCode() != Activity.RESULT_OK) {
            call.reject("Save cancelled.", "CANCELLED");
            return;
        }

        Intent resultIntent = result.getData();

        if (resultIntent == null || resultIntent.getData() == null) {
            call.reject("No save location was selected.");
            return;
        }

        final Uri destinationUri = resultIntent.getData();

        String sourceUriString = call.getString("sourceUri");

        if (sourceUriString == null) {
            call.reject("Source file is missing.");
            return;
        }

        final Uri sourceUri = Uri.parse(sourceUriString);

        // Copy on a background thread so a large backup can't freeze the UI.
        getBridge().execute(() -> {
            try (
                InputStream input = getContext()
                    .getContentResolver()
                    .openInputStream(sourceUri);
                OutputStream output = getContext()
                    .getContentResolver()
                    .openOutputStream(destinationUri)
            ) {
                if (input == null || output == null) {
                    call.reject("Could not access the selected file location.");
                    return;
                }

                byte[] buffer = new byte[64 * 1024];
                int length;

                while ((length = input.read(buffer)) != -1) {
                    output.write(buffer, 0, length);
                }

                output.flush();

                JSObject ret = new JSObject();
                ret.put("saved", true);
                ret.put("uri", destinationUri.toString());
                call.resolve(ret);

            } catch (Exception e) {
                // Don't leave a half-written backup at the destination
                try {
                    DocumentsContract.deleteDocument(
                        getContext().getContentResolver(),
                        destinationUri
                    );
                } catch (Exception ignored) {
                }

                call.reject("Could not save backup: " + e.getMessage());
            }
        });
    }
}