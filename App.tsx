import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Sharing from 'expo-sharing';
import { recognizeImage } from './ocr';

type ProfileType = 'groom' | 'bride' | 'unspecified';
type Salary = { amount: number; currency: string; period: string; sourceText?: string } | null;
type Profile = {
  id: string;
  profileType: ProfileType;
  identity: {
    fullName: string;
    dateOfBirth?: string | null;
    birthTime?: string | null;
    birthPlace?: string | null;
    heightCm?: number | null;
    community?: string | null;
  };
  astrology?: { rashi?: string | null; nakshatra?: string | null; pada?: number | null; swagotram?: string | null };
  educationAndCareer?: {
    education?: string[];
    occupation?: string | null;
    employer?: string | null;
    workLocation?: string | null;
    visaStatus?: string | null;
    annualSalary?: Salary;
  };
  contact?: { address?: string | null; phones?: { number: string; label: string }[] };
  preferences?: { partnerPreferenceText?: string | null; willingToRelocate?: boolean | null; preferredLocations?: string[] };
  assets?: { path: string; kind: string; role: string; dataUri?: string; mimeType?: string }[];
  recordMeta?: { needsReview?: boolean; notes?: string[] };
};

type ImportEnvelope = { profiles?: Profile[]; formatVersion?: number };
type Tab = 'Profiles' | 'Add' | 'Matches' | 'Share' | 'Vault';
type AttachedImage = { name: string; mimeType: string; dataUri: string };

const VAULT_KEY = 'nriva.vault.v1';
const today = new Date();

const ageOf = (date?: string | null) => {
  if (!date) return null;
  const born = new Date(`${date}T00:00:00`);
  let age = today.getFullYear() - born.getFullYear();
  if (today < new Date(today.getFullYear(), born.getMonth(), born.getDate())) age -= 1;
  return age;
};

const locationText = (profile: Profile) =>
  [profile.identity.birthPlace, profile.educationAndCareer?.workLocation, ...(profile.preferences?.preferredLocations ?? [])]
    .filter(Boolean)
    .join(' · ');

const publicProfile = (profile: Profile, includeContact: boolean): Profile => {
  const copy = JSON.parse(JSON.stringify(profile)) as Profile;
  if (!includeContact) delete copy.contact;
  return copy;
};

const shortSummary = (profile: Profile) => {
  const age = ageOf(profile.identity.dateOfBirth);
  const salary = profile.educationAndCareer?.annualSalary?.sourceText;
  return [
    profile.identity.fullName,
    age ? `Age ${age}` : null,
    profile.identity.heightCm ? `${Math.round(profile.identity.heightCm)} cm` : null,
    profile.educationAndCareer?.occupation,
    profile.educationAndCareer?.workLocation,
    salary,
    profile.astrology?.rashi ? `Rashi: ${profile.astrology.rashi}` : null,
  ].filter(Boolean).join('\n');
};

const valueAfterLabel = (text: string, labels: string[]) => {
  const label = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return text.match(new RegExp(`(?:${label})\\s*[:\\-]\\s*([^\\n]+)`, 'i'))?.[1]?.trim() ?? null;
};

const normalizeDate = (value: string | null) => {
  if (!value) return null;
  const match = value.match(/(\d{1,2})[\/.\- ]([a-zA-Z]{3,9}|\d{1,2})[\/.\-, ](\d{2,4})/);
  if (!match) return null;
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = Number.isNaN(Number(match[2])) ? monthNames.indexOf(match[2].slice(0, 3).toLowerCase()) + 1 : Number(match[2]);
  const year = match[3].length === 2 ? Number(`19${match[3]}`) : Number(match[3]);
  const day = Number(match[1]);
  return month && day <= 31 ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
};

const parseProfileText = (text: string, profileType: ProfileType, images: AttachedImage[]): Profile => {
  const name = valueAfterLabel(text, ['name', 'full name']) ?? 'Needs review';
  const heightText = valueAfterLabel(text, ['height']);
  const feetMatch = heightText?.match(/(\d)\s*(?:ft|feet|')\s*(\d{1,2})?/i);
  const cmMatch = heightText?.match(/(\d{3})\s*cm/i);
  const heightCm = cmMatch ? Number(cmMatch[1]) : feetMatch ? Math.round((Number(feetMatch[1]) * 12 + Number(feetMatch[2] ?? 0)) * 2.54) : null;
  const phoneMatches = [...text.matchAll(/(?:\+?91[\s-]?)?[6-9]\d{9}/g)].map((match) => match[0].replace(/[^\d+]/g, ''));
  const dateOfBirth = normalizeDate(valueAfterLabel(text, ['date of birth', 'dob']));
  const rashi = valueAfterLabel(text, ['rashi', 'raashi']);
  const nakshatra = valueAfterLabel(text, ['nakshatra', 'nakshatram', 'star']);
  const gotram = valueAfterLabel(text, ['swagotram', 'gotram', 'gothram']);
  const occupation = valueAfterLabel(text, ['occupation', 'present position', 'profession', 'job']);
  const workLocation = valueAfterLabel(text, ['work location', 'location', 'working at']);
  const education = valueAfterLabel(text, ['education', 'qualification']);
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'profile'}-${Date.now()}`;
  return {
    id,
    profileType,
    identity: { fullName: name, dateOfBirth, birthTime: valueAfterLabel(text, ['time of birth', 'time']), birthPlace: valueAfterLabel(text, ['place of birth', 'birth place']), heightCm, community: valueAfterLabel(text, ['caste', 'community']) },
    astrology: { rashi, nakshatra, pada: null, swagotram: gotram },
    educationAndCareer: { education: education ? [education] : [], occupation, employer: valueAfterLabel(text, ['employer', 'organization', 'company']), workLocation, visaStatus: valueAfterLabel(text, ['visa status', 'visa']), annualSalary: null },
    contact: { address: valueAfterLabel(text, ['address']), phones: phoneMatches.map((number) => ({ number, label: 'source document' })) },
    assets: images.map((image, index) => ({ path: `local-media:${id}:${image.name}`, kind: 'portrait', role: index === 0 ? 'profile-photo' : 'gallery', dataUri: image.dataUri, mimeType: image.mimeType })),
    recordMeta: { needsReview: true, notes: ['Created from uploaded text or OCR. Verify every extracted field before sharing.'] },
  };
};

export default function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [tab, setTab] = useState<Tab>('Vault');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | ProfileType>('all');
  const [locationFilter, setLocationFilter] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [seekerId, setSeekerId] = useState('');
  const [includeContact, setIncludeContact] = useState(false);
  const [detail, setDetail] = useState<Profile | null>(null);
  const [notice, setNotice] = useState('Import your private profiles.json to begin. Nothing is uploaded by this app.');
  const [profileText, setProfileText] = useState('');
  const [newProfileType, setNewProfileType] = useState<ProfileType>('groom');
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [ocrProgress, setOcrProgress] = useState<number | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(VAULT_KEY).then((raw) => {
      if (!raw) return;
      try {
        const saved = JSON.parse(raw) as Profile[];
        setProfiles(saved);
        setNotice(`${saved.length} profiles loaded from this device.`);
      } catch {
        setNotice('Saved vault could not be read. Import a valid JSON export to recover.');
      }
    });
  }, []);

  const saveVault = async (next: Profile[]) => {
    setProfiles(next);
    await AsyncStorage.setItem(VAULT_KEY, JSON.stringify(next));
  };

  const importVault = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/json'], copyToCacheDirectory: true });
    if (result.canceled) return;
    try {
      const asset = result.assets[0];
      const text = Platform.OS === 'web' && asset.file
        ? await asset.file.text()
        : await FileSystem.readAsStringAsync(asset.uri);
      const parsed = JSON.parse(text) as ImportEnvelope;
      const incoming = parsed.profiles;
      if (!Array.isArray(incoming) || incoming.some((profile) => !profile.id || !profile.identity?.fullName)) {
        throw new Error('Expected a profiles.json or a Matrimonial Share Package with a profiles array.');
      }
      const existing = new Map(profiles.map((profile) => [profile.id, profile]));
      let added = 0;
      let updated = 0;
      incoming.forEach((profile) => {
        if (existing.has(profile.id)) updated += 1;
        else added += 1;
        existing.set(profile.id, profile);
      });
      await saveVault([...existing.values()]);
      setNotice(`Imported ${added} new and ${updated} updated profile(s). Review all imported details before sharing.`);
      setTab('Profiles');
    } catch (error) {
      Alert.alert('Import failed', error instanceof Error ? error.message : 'The selected file is not a valid profile package.');
    }
  };

  const readAsDataUri = async (asset: DocumentPicker.DocumentPickerAsset): Promise<AttachedImage> => {
    const mimeType = asset.mimeType ?? 'image/jpeg';
    if (Platform.OS === 'web' && asset.file) {
      const dataUri = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error(`Could not read ${asset.name}.`));
        reader.readAsDataURL(asset.file!);
      });
      return { name: asset.name, mimeType, dataUri };
    }
    const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
    return { name: asset.name, mimeType, dataUri: `data:${mimeType};base64,${base64}` };
  };

  const addPictures = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: 'image/*', multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return;
    try {
      const images = await Promise.all(result.assets.map(readAsDataUri));
      setAttachedImages((current) => [...current, ...images]);
      setNotice(`${images.length} image(s) attached to the new profile. They will be embedded in the exported JSON.`);
    } catch (error) {
      Alert.alert('Could not add pictures', error instanceof Error ? error.message : 'Try a smaller image file.');
    }
  };

  const runOcr = async () => {
    if (Platform.OS !== 'web') {
      Alert.alert('Use the web app for OCR', 'On iOS and Android, add photos and paste the biodata text. Browser OCR runs privately on your device.');
      return;
    }
    const source = attachedImages[0];
    if (!source) return Alert.alert('Add a biodata image first', 'Choose an image, then run OCR to copy readable text into the profile form.');
    try {
      setOcrProgress(0);
      const blob = await fetch(source.dataUri).then((response) => response.blob());
      const file = new File([blob], source.name, { type: source.mimeType });
      const text = await recognizeImage(file, setOcrProgress);
      setProfileText((current) => current ? `${current}\n\n${text}` : text);
      setNotice('OCR text added. Review and correct it before saving the profile.');
    } catch (error) {
      Alert.alert('OCR could not read this image', error instanceof Error ? error.message : 'Try a clearer biodata image.');
    } finally {
      setOcrProgress(null);
    }
  };

  const saveNewProfile = async () => {
    if (!profileText.trim()) return Alert.alert('Add profile text', 'Paste biodata text or run OCR, then review it before saving.');
    const profile = parseProfileText(profileText, newProfileType, attachedImages);
    await saveVault([...profiles, profile]);
    setSelectedIds((current) => [...current, profile.id]);
    setProfileText('');
    setAttachedImages([]);
    setNotice(`${profile.identity.fullName} was saved locally. It is selected and ready to share after review.`);
    setTab('Profiles');
  };

  const exportVault = async () => {
    const payload = { databaseVersion: 2, exportedAt: new Date().toISOString(), privacy: { classification: 'private' }, profiles };
    const filename = `nriva-vault-${Date.now()}.json`;
    if (Platform.OS === 'web') {
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice('Full private vault downloaded. Keep this file secure because it can include embedded pictures and contact details.');
      return;
    }
    const uri = `${FileSystem.cacheDirectory}${filename}`;
    await FileSystem.writeAsStringAsync(uri, JSON.stringify(payload, null, 2));
    await Sharing.shareAsync(uri, { mimeType: 'application/json', dialogTitle: 'Export private matrimonial vault' });
  };

  const exportSelection = async () => {
    const chosen = profiles.filter((profile) => selectedIds.includes(profile.id));
    if (!chosen.length) {
      Alert.alert('Select profiles', 'Choose one or more profiles in Profiles before creating a share package.');
      return;
    }
    const payload = {
      formatVersion: 1,
      sharedAt: new Date().toISOString(),
      privacy: { contactIncluded: includeContact, note: 'Import only after confirming the sender has consent to share.' },
      profiles: chosen.map((profile) => publicProfile(profile, includeContact)),
    };
    const filename = `nriva-share-${Date.now()}.json`;
    if (Platform.OS === 'web') {
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice('Share package downloaded. Send that JSON file through WhatsApp and the recipient can import it.');
      return;
    }
    const uri = `${FileSystem.cacheDirectory}${filename}`;
    await FileSystem.writeAsStringAsync(uri, JSON.stringify(payload, null, 2));
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, { mimeType: 'application/json', dialogTitle: 'Share selected matrimonial profiles' });
      setNotice('Share package opened in the device share sheet.');
    } else {
      await Share.share({ message: JSON.stringify(payload) });
    }
  };

  const shareWhatsAppSummary = async () => {
    const chosen = profiles.filter((profile) => selectedIds.includes(profile.id));
    if (!chosen.length) return Alert.alert('Select profiles', 'Select profile cards first.');
    const text = `Matrimonial profile${chosen.length > 1 ? 's' : ''} shared with consent\n\n${chosen.map(shortSummary).join('\n\n—\n\n')}\n\nPlease request an introduction before forwarding.`;
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
    const supported = await Linking.canOpenURL(whatsappUrl);
    if (supported) await Linking.openURL(whatsappUrl);
    else await Share.share({ message: text });
  };

  const visibleProfiles = useMemo(() => profiles.filter((profile) => {
    const searchable = `${profile.identity.fullName} ${profile.educationAndCareer?.occupation ?? ''} ${locationText(profile)} ${profile.astrology?.rashi ?? ''}`.toLowerCase();
    return (typeFilter === 'all' || profile.profileType === typeFilter)
      && (!query || searchable.includes(query.toLowerCase()))
      && (!locationFilter || locationText(profile).toLowerCase().includes(locationFilter.toLowerCase()));
  }), [profiles, query, typeFilter, locationFilter]);

  const seeker = profiles.find((profile) => profile.id === seekerId);
  const matches = useMemo(() => {
    if (!seeker) return [];
    return profiles
      .filter((candidate) => candidate.id !== seeker.id && candidate.profileType !== seeker.profileType && candidate.profileType !== 'unspecified')
      .map((candidate) => {
        const blockers: string[] = [];
        const reviews: string[] = [];
        const seekerAge = ageOf(seeker.identity.dateOfBirth);
        const candidateAge = ageOf(candidate.identity.dateOfBirth);
        const groom = seeker.profileType === 'groom' ? seeker : candidate;
        const bride = seeker.profileType === 'bride' ? seeker : candidate;
        const groomAge = ageOf(groom.identity.dateOfBirth);
        const brideAge = ageOf(bride.identity.dateOfBirth);
        if (groomAge !== null && brideAge !== null && brideAge >= groomAge) blockers.push('Age rule needs review: bride is not younger.');
        if (groom.identity.heightCm && bride.identity.heightCm && groom.identity.heightCm <= bride.identity.heightCm) blockers.push('Height rule needs review: groom is not taller.');
        if (!groom.identity.heightCm || !bride.identity.heightCm) reviews.push('Height is incomplete.');
        const groomGotram = groom.astrology?.swagotram?.trim().toLowerCase();
        const brideGotram = bride.astrology?.swagotram?.trim().toLowerCase();
        if (groomGotram && brideGotram && groomGotram === brideGotram) blockers.push('Same swagotram.');
        if (!groomGotram || !brideGotram) reviews.push('Gotram needs family review.');
        if (!groom.astrology?.rashi || !bride.astrology?.rashi) reviews.push('Rashi is incomplete; consult an astrologer once birth details are verified.');
        if (!locationText(seeker) || !locationText(candidate)) reviews.push('Location or relocation preference is incomplete.');
        const score = 100 - blockers.length * 45 - reviews.length * 8;
        return { candidate, blockers, reviews, score, seekerAge, candidateAge };
      })
      .sort((a, b) => b.score - a.score);
  }, [profiles, seeker]);

  const toggleSelected = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={styles.brand}>Nriva</Text>
        <Text style={styles.tagline}>Private matrimonial matching</Text>
      </View>
      <View style={styles.tabs}>
        {(['Profiles', 'Add', 'Matches', 'Share', 'Vault'] as Tab[]).map((item) => (
          <Pressable key={item} onPress={() => setTab(item)} style={[styles.tab, tab === item && styles.tabActive]}>
            <Text style={[styles.tabText, tab === item && styles.tabTextActive]}>{item}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {tab === 'Vault' && (
          <View style={styles.stack}>
            <Text style={styles.title}>Your private vault</Text>
            <Text style={styles.body}>{notice}</Text>
            <View style={styles.statRow}>
              <Stat label="Profiles" value={profiles.length} />
              <Stat label="Grooms" value={profiles.filter((p) => p.profileType === 'groom').length} />
              <Stat label="Brides" value={profiles.filter((p) => p.profileType === 'bride').length} />
            </View>
            <Action label="Import profiles or a share package" onPress={importVault} />
            <Action label="Export complete private vault" onPress={exportVault} secondary disabled={!profiles.length} />
            <Text style={styles.hint}>Import your existing private `data/private/profiles.json` on each device. The app stores it locally and does not sync it to GitHub Pages.</Text>
          </View>
        )}

        {tab === 'Profiles' && (
          <View style={styles.stack}>
            <Text style={styles.title}>Browse and select profiles</Text>
            <TextInput value={query} onChangeText={setQuery} placeholder="Name, profession, rashi…" style={styles.input} />
            <TextInput value={locationFilter} onChangeText={setLocationFilter} placeholder="Location" style={styles.input} />
            <View style={styles.filterRow}>
              {(['all', 'groom', 'bride'] as const).map((filter) => <Pill key={filter} label={filter} active={typeFilter === filter} onPress={() => setTypeFilter(filter)} />)}
            </View>
            {!visibleProfiles.length && <Empty text="No local profiles yet. Import your private JSON from the Vault tab." />}
            {visibleProfiles.map((profile) => (
              <ProfileCard key={profile.id} profile={profile} selected={selectedIds.includes(profile.id)} onToggle={() => toggleSelected(profile.id)} onOpen={() => setDetail(profile)} />
            ))}
          </View>
        )}

        {tab === 'Add' && (
          <View style={styles.stack}>
            <Text style={styles.title}>Add a profile</Text>
            <Text style={styles.body}>Paste biodata text, upload a biodata image, or do both. OCR runs in your web browser; review every field before saving.</Text>
            <View style={styles.filterRow}>
              {(['groom', 'bride'] as const).map((type) => <Pill key={type} label={type} active={newProfileType === type} onPress={() => setNewProfileType(type)} />)}
            </View>
            <Action label="Add biodata or profile pictures" onPress={addPictures} secondary />
            <Action label={ocrProgress === null ? 'Run OCR on first image' : `Reading image… ${ocrProgress}%`} onPress={runOcr} disabled={ocrProgress !== null || !attachedImages.length} />
            {!!attachedImages.length && <ScrollView horizontal contentContainerStyle={styles.imageRow}>{attachedImages.map((image) => <Image key={`${image.name}-${image.dataUri.length}`} source={{ uri: image.dataUri }} style={styles.thumbnail} />)}</ScrollView>}
            <TextInput value={profileText} onChangeText={setProfileText} placeholder={'Paste biodata, for example:\nName: ...\nDOB: ...\nHeight: ...\nRashi: ...\nGotram: ...\nOccupation: ...'} multiline textAlignVertical="top" style={styles.textArea} />
            <Action label="Review text and save profile" onPress={saveNewProfile} disabled={!profileText.trim()} />
            <Text style={styles.hint}>Uploaded photos are embedded in this device’s vault and in its JSON export. Large photos can exceed browser storage; add a small number of compressed images per profile.</Text>
          </View>
        )}

        {tab === 'Matches' && (
          <View style={styles.stack}>
            <Text style={styles.title}>Find matches for a profile</Text>
            <Text style={styles.body}>Choose the person whose needs you want to apply. Results are a shortlist, not a horoscope decision.</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
              {profiles.map((profile) => <Pill key={profile.id} label={profile.identity.fullName.split(' ')[0]} active={seekerId === profile.id} onPress={() => setSeekerId(profile.id)} />)}
            </ScrollView>
            {!seeker && <Empty text="Select a profile to see compatible opposite-side candidates." />}
            {matches.map(({ candidate, blockers, reviews, score }) => (
              <Pressable key={candidate.id} onPress={() => setDetail(candidate)} style={styles.matchCard}>
                <View style={styles.matchHeading}><Text style={styles.cardName}>{candidate.identity.fullName}</Text><Text style={styles.score}>{Math.max(score, 0)}%</Text></View>
                <Text style={styles.cardMeta}>{shortSummary(candidate).split('\n').slice(1).join(' · ')}</Text>
                {!!blockers.length && <Text style={styles.blocker}>{blockers.join(' ')}</Text>}
                {!!reviews.length && <Text style={styles.review}>{reviews.join(' ')}</Text>}
              </Pressable>
            ))}
          </View>
        )}

        {tab === 'Share' && (
          <View style={styles.stack}>
            <Text style={styles.title}>Share selected profiles</Text>
            <Text style={styles.body}>{selectedIds.length} profile(s) selected. By default the package excludes phones and addresses.</Text>
            <View style={styles.switchRow}><Text style={styles.body}>Include contact details (only with consent)</Text><Switch value={includeContact} onValueChange={setIncludeContact} /></View>
            <Action label="Create share package" onPress={exportSelection} disabled={!selectedIds.length} />
            <Action label="Send summary on WhatsApp" onPress={shareWhatsAppSummary} secondary disabled={!selectedIds.length} />
            <Text style={styles.hint}>Use “Create share package” for recipients to import profiles back into their vault. WhatsApp summary is for a quick introduction only.</Text>
          </View>
        )}
      </ScrollView>
      <Modal visible={detail !== null} animationType="slide" onRequestClose={() => setDetail(null)}>
        <SafeAreaView style={styles.safe}>
          <ScrollView contentContainerStyle={styles.detail}>
            <Pressable onPress={() => setDetail(null)}><Text style={styles.close}>Close</Text></Pressable>
            {detail && <><Text style={styles.title}>{detail.identity.fullName}</Text><Text style={styles.detailType}>{detail.profileType.toUpperCase()}</Text><Text style={styles.detailText}>{shortSummary(detail)}</Text><Text style={styles.section}>Education</Text><Text style={styles.detailText}>{detail.educationAndCareer?.education?.join('\n') || 'Not provided'}</Text><Text style={styles.section}>Astrology</Text><Text style={styles.detailText}>{[detail.astrology?.rashi && `Rashi: ${detail.astrology.rashi}`, detail.astrology?.nakshatra && `Nakshatra: ${detail.astrology.nakshatra}`, detail.astrology?.swagotram && `Swagotram: ${detail.astrology.swagotram}`].filter(Boolean).join('\n') || 'Not provided'}</Text><Text style={styles.hint}>Contact details remain hidden here; share only after consent.</Text></>}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <View style={styles.stat}><Text style={styles.statValue}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>;
}

function Action({ label, onPress, secondary = false, disabled = false }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean }) {
  return <Pressable disabled={disabled} onPress={onPress} style={[styles.action, secondary && styles.actionSecondary, disabled && styles.disabled]}><Text style={[styles.actionText, secondary && styles.actionTextSecondary]}>{label}</Text></Pressable>;
}

function Pill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return <Pressable onPress={onPress} style={[styles.pill, active && styles.pillActive]}><Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text></Pressable>;
}

function Empty({ text }: { text: string }) {
  return <View style={styles.empty}><Text style={styles.hint}>{text}</Text></View>;
}

function ProfileCard({ profile, selected, onToggle, onOpen }: { profile: Profile; selected: boolean; onToggle: () => void; onOpen: () => void }) {
  return <View style={[styles.card, selected && styles.cardSelected]}>
    <Pressable onPress={onOpen}><Text style={styles.cardName}>{profile.identity.fullName}</Text><Text style={styles.cardMeta}>{shortSummary(profile).split('\n').slice(1).join(' · ') || 'Details need review'}</Text><Text style={styles.badge}>{profile.profileType}</Text></Pressable>
    <Pressable onPress={onToggle} style={styles.select}><Text style={styles.selectText}>{selected ? 'Selected' : 'Select'}</Text></Pressable>
  </View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fffaf5' },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16, backgroundColor: '#3f1d3e' },
  brand: { color: '#fff5e6', fontSize: 30, fontWeight: '800' },
  tagline: { color: '#e9c7dc', marginTop: 2 },
  tabs: { flexDirection: 'row', backgroundColor: '#fff', borderBottomWidth: 1, borderColor: '#eadfd5' },
  tab: { flex: 1, paddingVertical: 13, alignItems: 'center' },
  tabActive: { borderBottomWidth: 3, borderColor: '#9b3f77' },
  tabText: { color: '#796c70', fontWeight: '600' },
  tabTextActive: { color: '#5d214b' },
  content: { padding: 18, paddingBottom: 46 },
  stack: { gap: 12 },
  title: { fontSize: 25, fontWeight: '800', color: '#3f1d3e' },
  body: { color: '#554a4d', fontSize: 15, lineHeight: 21 },
  hint: { color: '#806f73', fontSize: 13, lineHeight: 19 },
  statRow: { flexDirection: 'row', gap: 10 },
  stat: { flex: 1, padding: 13, backgroundColor: '#f4e9ef', borderRadius: 12 },
  statValue: { fontSize: 23, color: '#6e2757', fontWeight: '800' },
  statLabel: { color: '#725d65', fontSize: 12, marginTop: 2 },
  action: { padding: 15, alignItems: 'center', borderRadius: 12, backgroundColor: '#7c2d62' },
  actionSecondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#7c2d62' },
  disabled: { opacity: 0.45 },
  actionText: { color: '#fff', fontWeight: '800' },
  actionTextSecondary: { color: '#7c2d62' },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#dfd1d5', borderRadius: 10, padding: 12, fontSize: 15 },
  textArea: { minHeight: 220, backgroundColor: '#fff', borderWidth: 1, borderColor: '#dfd1d5', borderRadius: 10, padding: 12, fontSize: 15, lineHeight: 21 },
  imageRow: { gap: 9, paddingVertical: 2 },
  thumbnail: { width: 86, height: 106, borderRadius: 8, backgroundColor: '#eee' },
  filterRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  pill: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 18, backgroundColor: '#efe7e9' },
  pillActive: { backgroundColor: '#6c2856' },
  pillText: { color: '#654e56', textTransform: 'capitalize', fontWeight: '600' },
  pillTextActive: { color: '#fff' },
  card: { padding: 14, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e6d8dc', borderRadius: 13, gap: 9 },
  cardSelected: { borderColor: '#9b3f77', borderWidth: 2 },
  cardName: { color: '#3e2238', fontSize: 17, fontWeight: '800' },
  cardMeta: { color: '#75656a', fontSize: 13, lineHeight: 19, marginTop: 4 },
  badge: { color: '#8c3c70', fontSize: 12, textTransform: 'capitalize', fontWeight: '700', marginTop: 7 },
  select: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, backgroundColor: '#f2e2ec' },
  selectText: { color: '#742d5c', fontWeight: '800' },
  empty: { backgroundColor: '#f8f0f2', padding: 22, borderRadius: 12 },
  matchCard: { padding: 14, backgroundColor: '#fff', borderRadius: 13, borderWidth: 1, borderColor: '#e6d8dc', gap: 6 },
  matchHeading: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  score: { fontWeight: '900', color: '#267252', fontSize: 17 },
  blocker: { color: '#a33e3e', fontSize: 13, lineHeight: 18 },
  review: { color: '#876723', fontSize: 13, lineHeight: 18 },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: 12, backgroundColor: '#f7eef2', borderRadius: 10 },
  detail: { padding: 20, gap: 12 },
  close: { color: '#7c2d62', fontSize: 16, fontWeight: '800' },
  detailType: { color: '#9b3f77', fontWeight: '800' },
  detailText: { color: '#504247', fontSize: 16, lineHeight: 24 },
  section: { color: '#5e244a', marginTop: 8, fontWeight: '800', fontSize: 16 },
});
