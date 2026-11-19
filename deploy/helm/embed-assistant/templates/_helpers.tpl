{{- define "ea.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ea.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "ea.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "ea.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "ea.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ea.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "ea.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "ea.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "ea.secretName" -}}
{{- default (include "ea.fullname" .) .Values.existingSecret -}}
{{- end -}}

{{- define "ea.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{/* Pod spec shared by the web and worker Deployments. Call with (dict "root" $ "component" "web"|"worker"). */}}
{{- define "ea.podSpec" -}}
{{- $root := .root -}}
{{- $v := $root.Values -}}
serviceAccountName: {{ include "ea.serviceAccountName" $root }}
{{- with $v.imagePullSecrets }}
imagePullSecrets: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $v.priorityClassName }}
priorityClassName: {{ . }}
{{- end }}
securityContext: {{- toYaml $v.podSecurityContext | nindent 2 }}
terminationGracePeriodSeconds: {{ $v.terminationGracePeriodSeconds }}
containers:
  - name: {{ .component }}
    image: {{ include "ea.image" $root }}
    imagePullPolicy: {{ $v.image.pullPolicy }}
    securityContext: {{- toYaml $v.securityContext | nindent 6 }}
    ports:
      - name: http
        containerPort: 8787
        protocol: TCP
    env:
      - name: PORT
        value: "8787"
      - name: PUBLIC_BASE_URL
        value: {{ $v.publicBaseUrl | quote }}
      - name: RUN_WORKER
        value: {{ if eq .component "worker" }}"true"{{ else if $v.worker.separate }}"false"{{ else }}"true"{{ end }}
      {{- if $v.models }}
      - name: MODELS_CONFIG
        value: /etc/embed-assistant/models.json
      {{- end }}
      {{- range $k, $val := $v.env }}
      - name: {{ $k }}
        value: {{ $val | quote }}
      {{- end }}
    envFrom:
      - secretRef:
          name: {{ include "ea.secretName" $root }}
      {{- with $v.extraEnvFrom }}
      {{- toYaml . | nindent 6 }}
      {{- end }}
    startupProbe:
      httpGet: { path: /healthz, port: http }
      periodSeconds: 2
      failureThreshold: 60
    livenessProbe:
      httpGet: { path: /healthz, port: http }
      periodSeconds: 15
      timeoutSeconds: 3
    readinessProbe:
      httpGet: { path: /readyz, port: http }
      periodSeconds: 5
      timeoutSeconds: 3
    lifecycle:
      preStop:
        exec:
          command: ["node", "-e", "setTimeout(() => {}, {{ mul $v.preStopSleepSeconds 1000 }})"]
    resources: {{- toYaml (ternary $v.worker.resources $v.resources (and (eq .component "worker") (not (empty $v.worker.resources)))) | nindent 6 }}
    volumeMounts:
      - name: tmp
        mountPath: /tmp
      {{- if $v.models }}
      - name: models
        mountPath: /etc/embed-assistant
        readOnly: true
      {{- end }}
      {{- with $v.extraVolumeMounts }}
      {{- toYaml . | nindent 6 }}
      {{- end }}
volumes:
  - name: tmp
    emptyDir: {}
  {{- if $v.models }}
  - name: models
    configMap:
      name: {{ include "ea.fullname" $root }}-models
  {{- end }}
  {{- with $v.extraVolumes }}
  {{- toYaml . | nindent 2 }}
  {{- end }}
{{- with $v.nodeSelector }}
nodeSelector: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $v.affinity }}
affinity: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $v.tolerations }}
tolerations: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $v.topologySpreadConstraints }}
topologySpreadConstraints: {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
