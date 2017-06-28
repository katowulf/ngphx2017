// Import the Firebase SDK for Google Cloud Functions.
const functions = require('firebase-functions');

// Import and initialize the Firebase Admin SDK.
const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);

// Used by our image moderation
const gcs = require('@google-cloud/storage')();
const vision = require('@google-cloud/vision')();
const exec = require('child-process-promise').exec;

exports.welcomeMessage = functions.auth.user().onCreate(event => {
  console.log('A new user has joined!'); //debug
  const user = event.data;
  const fullName = user.displayName || 'Anon';
  return admin.database().ref('messages').push({
    name: 'Firebase Bot',
    photoUrl: '/assets/images/firebase-logo.png', // Firebase logo
    text: `${fullName} signed in for the first time! Welcome!`
  });
});

exports.modImage = functions.storage.object().onChange(event => {
  const object = event.data;
  // Exit if this is a deletion or a deploy event.
  if (object.resourceState === 'not_exists') {
    return console.log('This is a deletion event.');
  } else if (!object.name) {
    return console.log('This is a deploy event.');
  }

  const messageId = object.name.split('/')[1];
  const bucket = gcs.bucket(object.bucket);
  const file = bucket.file(object.name);

  return admin.database().ref(`messages/${messageId}/moderated`)
    .once('value')
    .then(snap => {
      if( snap.val() ) {
        return false;
      }
      return vision.detectSafeSearch(file);
    })
    .then(result => {
      if (result && result[0].adult || result[0].violence) {
        console.log('The image', object.name, 'has been detected as inappropriate.');
        return blurImage(object.name, bucket);
      } else {
        console.log('The image', object.name,'has been detected as OK.');
      }
    });
});

// Blurs the given image located in the given bucket using ImageMagick.
function blurImage(filePath, bucket, metadata) {
  const fileName = filePath.split('/').pop();
  const tempLocalFile = `/tmp/${fileName}`;
  const messageId = filePath.split('/')[1];

  // Download file from bucket.
  return bucket.file(filePath).download({ destination: tempLocalFile })
    .then(() => {
      console.log('Image has been downloaded to', tempLocalFile);
      // Blur the image using ImageMagick.
      return exec(`convert ${tempLocalFile} -channel RGBA -blur 0x24 ${tempLocalFile}`);
    })
    .then(() => {
      console.log('Image has been blurred');
      // Uploading the Blurred image back into the bucket.
      return bucket.upload(tempLocalFile, { destination: filePath });
    })
    .then(() => {
      console.log('Blurred image has been uploaded to', filePath);
      // Indicate that the message has been moderated.
      return admin.database().ref(`/messages/${messageId}`).update({ moderated: true });
    })
    .then(() => {
      console.log('Marked the image as moderated in the database.');
    });
}
